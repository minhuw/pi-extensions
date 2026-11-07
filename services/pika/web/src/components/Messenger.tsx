import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, useApi } from "../lib/api";
import { deviceLabel } from "../lib/devices";
import { formatDateTime, formatRelative } from "../lib/format";
import { bareModelOf } from "../lib/model";
import {
	isRelayDisabled,
	MAX_TEXT_BYTES,
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
	RelayRoom,
	RelayRoomMember,
	RelayRoomMessage,
	RelaySender,
} from "../lib/types";
import { Icon } from "./icons";
import { useSigningOut } from "./Layout";
import { ModelMark } from "./ModelName";
import { cx } from "./ui";

export type ThreadSelection =
	| { kind: "dm"; sessionId: string }
	| { kind: "room"; room: string };

type FilterTab = "all" | "dm" | "rooms";

interface DmThread {
	kind: "dm";
	key: string;
	sessionId: string;
	label: string;
	device: string;
	project: string;
	model?: string;
	state: "idle" | "busy" | "offline";
	online: boolean;
	recorded: boolean;
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

const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function monogram(label: string): string {
	const cleaned = label.replace(/^#/, "").trim();
	if (!cleaned) return "?";
	const words = cleaned.split(/[\s._-]+/).filter(Boolean);
	if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
	return cleaned.slice(0, 2).toUpperCase();
}

function senderShortName(sender: RelaySender): string {
	if (sender.kind === "web") return "You";
	return sessionLabel(sender);
}

function senderMetaLine(sender: RelaySender): string {
	if (sender.kind === "web") return "You (web)";
	const name = sessionLabel(sender);
	const dev = deviceLabel(sender);
	const proj = sender.project ? ` · ${sender.project}` : "";
	return `${name}${proj}${dev ? ` on ${dev}` : ""}`;
}

/** Highlights `@mention` tokens inside bubble text. */
function renderBubbleText(text: string, outgoing: boolean) {
	const parts = text.split(/(@[A-Za-z0-9._-]+)/g);
	return parts.map((part, idx) => {
		if (part.startsWith("@") && part.length > 1) {
			return (
				<span
					key={idx}
					className={cx(
						"inline-block rounded-[6px] px-1 font-semibold",
						outgoing ? "bg-white/20 text-white" : "bg-[#007AFF]/12 text-[#0062CC] dark:bg-[#0A84FF]/25 dark:text-[#66B2FF]",
					)}
				>
					{part}
				</span>
			);
		}
		return part;
	});
}

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

	const roomsQuery = useQuery({
		queryKey: RELAY_ROOMS_KEY,
		queryFn: () => api.relayRooms(),
		enabled: !signingOut,
		staleTime: 0,
		refetchInterval: (query) => (signingOut || isRelayDisabled(query.state.error) ? false : RELAY_POLL_MS),
	});
	const rooms = roomsQuery.data?.items ?? [];

	const [filter, setFilter] = useState<FilterTab>("all");
	const [search, setSearch] = useState("");
	const [internalThread, setInternalThread] = useState<ThreadSelection | null>(null);
	const activeThread = selectedThread !== undefined ? selectedThread : internalThread;
	const setActiveThread = (next: ThreadSelection) => {
		setInternalThread(next);
		onSelectThread?.(next);
	};

	// New room sheet state
	const [creatingRoom, setCreatingRoom] = useState(false);
	const [newRoomName, setNewRoomName] = useState("");
	const [newRoomTopic, setNewRoomTopic] = useState("");
	const [newRoomMembers, setNewRoomMembers] = useState<ReadonlySet<string>>(() => new Set());
	const [roomFormError, setRoomFormError] = useState<string | null>(null);
	const [savingRoom, setSavingRoom] = useState(false);

	// Room member drawer state
	const [managingMembers, setManagingMembers] = useState(false);
	const [memberBusyId, setMemberBusyId] = useState<string | null>(null);

	// Composer state
	const [text, setText] = useState("");
	const [urgent, setUrgent] = useState(false);
	const [selectedMentions, setSelectedMentions] = useState<ReadonlySet<string>>(() => new Set());
	const [sending, setSending] = useState(false);
	const [sendFeedback, setSendFeedback] = useState<{ tone: "ok" | "queued" | "error"; message: string } | null>(null);
	const streamRef = useRef<HTMLDivElement>(null);

	// Build unified DM + Room threads list
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
				online: true,
				recorded: s.recorded,
				lastAt: Date.parse(s.stateSince) || Date.parse(s.connectedAt) || 0,
				preview: s.cwd,
			});
		}

		// Fold 1:1 events into DM threads so offline sessions that exchanged messages still show up
		for (const ev of events) {
			if (ev.room || ev.to.sessionId.startsWith("#")) continue;
			const peerId = ev.from.kind === "session" ? ev.from.sessionId : ev.to.sessionId;
			if (!peerId) continue;
			const evTime = Date.parse(ev.at) || 0;
			const line = `${senderShortName(ev.from)}: ${ev.text.replace(/\s+/g, " ").trim()}`;
			const existing = dmMap.get(peerId);
			if (existing) {
				if (evTime >= existing.lastAt || existing.preview.startsWith("/")) {
					existing.lastAt = Math.max(existing.lastAt, evTime);
					existing.preview = line;
				}
			} else {
				const meta = ev.from.kind === "session" && ev.from.sessionId === peerId ? ev.from : ev.to;
				dmMap.set(peerId, {
					kind: "dm",
					key: `dm:${peerId}`,
					sessionId: peerId,
					label: sessionLabel(meta),
					device: meta.device ? deviceLabel({ device: meta.device, deviceName: meta.deviceName }) : "offline",
					project: meta.project || "—",
					state: "offline",
					online: false,
					recorded: false,
					lastAt: evTime,
					preview: line,
				});
			}

			// If a session messaged another session, also update the recipient's preview
			if (ev.from.kind === "session" && ev.to.sessionId && ev.to.sessionId !== peerId) {
				const targetId = ev.to.sessionId;
				const rec = dmMap.get(targetId);
				if (rec) {
					if (evTime >= rec.lastAt || rec.preview.startsWith("/")) {
						rec.lastAt = Math.max(rec.lastAt, evTime);
						rec.preview = line;
					}
				}
			}
		}

		const roomThreads: RoomThread[] = rooms.map((r) => ({
			kind: "room",
			key: `room:${r.name}`,
			room: r,
			lastAt: Date.parse(r.updatedAt) || Date.parse(r.createdAt) || 0,
			preview: r.lastMessage
				? `${senderShortName(r.lastMessage.from)}: ${r.lastMessage.text.replace(/\s+/g, " ").trim()}`
				: r.topic || `${r.members.length} member${r.members.length === 1 ? "" : "s"}`,
		}));

		const all: ThreadItem[] = [...roomThreads, ...dmMap.values()];
		all.sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key));
		return all;
	}, [sessions, events, rooms]);

	const filteredThreads = useMemo(() => {
		const q = search.trim().toLowerCase();
		return threads.filter((item) => {
			if (filter === "dm" && item.kind !== "dm") return false;
			if (filter === "rooms" && item.kind !== "room") return false;
			if (!q) return true;
			if (item.kind === "room") {
				return (
					item.room.name.toLowerCase().includes(q)
					|| (item.room.topic?.toLowerCase().includes(q) ?? false)
					|| item.room.members.some(
						(m) =>
							m.sessionId.toLowerCase().includes(q)
							|| (m.name?.toLowerCase().includes(q) ?? false)
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
	}, [threads, filter, search]);

	// Auto-select the first available thread when none is selected or the selected room was deleted
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
	}, [resolvedKey]);

	// Direct message conversation events (oldest first for chat transcript)
	const dmEvents = useMemo(() => {
		if (resolvedSelection?.kind !== "dm") return [];
		const sid = resolvedSelection.sessionId;
		return [...events]
			.filter((ev) => !ev.room && !ev.to.sessionId.startsWith("#") && (ev.to.sessionId === sid || (ev.from.kind === "session" && ev.from.sessionId === sid)))
			.reverse();
	}, [events, resolvedSelection]);

	const activeRoom: RelayRoom | undefined = useMemo(() => {
		if (resolvedSelection?.kind !== "room") return undefined;
		return roomDetailQuery.data?.room ?? rooms.find((r) => r.name === resolvedSelection.room);
	}, [resolvedSelection, roomDetailQuery.data, rooms]);

	const roomMessages: RelayRoomMessage[] = roomDetailQuery.data?.messages ?? [];

	const activeDm: DmThread | undefined = useMemo(() => {
		if (resolvedSelection?.kind !== "dm") return undefined;
		return threads.find((t): t is DmThread => t.kind === "dm" && t.sessionId === resolvedSelection.sessionId);
	}, [resolvedSelection, threads]);

	// Keep scroll anchored at bottom when new messages arrive
	const messageCountKey = resolvedSelection?.kind === "room" ? roomMessages.length : dmEvents.length;
	useEffect(() => {
		const node = streamRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [messageCountKey, resolvedSelection?.kind]);

	const bytes = utf8Length(text);
	const tooLong = bytes > MAX_TEXT_BYTES;
	const canSend = Boolean(resolvedSelection) && text.trim() !== "" && !tooLong && !sending;

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
			setRoomFormError("Use 1–64 letters, digits, dots, hyphens, or underscores (e.g. auth-sync).");
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
			const msg = cause instanceof ApiError ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause);
			setRoomFormError(msg);
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
		try {
			if (resolvedSelection.kind === "dm") {
				const sent = await api.sendRelayMessage({
					to: resolvedSelection.sessionId,
					text,
					urgent,
				});
				setText("");
				setUrgent(false);
				setSendFeedback({
					tone: sent.status === "delivered" ? "ok" : "queued",
					message: sent.status === "delivered" ? "Delivered" : "Queued (delivered when online)",
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
				const notifiedCount = sent.notified?.length ?? 0;
				setSendFeedback({
					tone: "ok",
					message:
						notifiedCount > 0
							? `Posted · notified ${notifiedCount} agent${notifiedCount === 1 ? "" : "s"}`
							: "Posted to room history",
				});
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
					queryClient.invalidateQueries({ queryKey: relayRoomKey(resolvedSelection.room) }),
					queryClient.invalidateQueries({ queryKey: RELAY_EVENTS_KEY }),
				]);
			}
		} catch (cause) {
			const refused = cause instanceof ApiError && [400, 404, 429].includes(cause.status);
			setSendFeedback({
				tone: "error",
				message: refused ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			setSending(false);
		}
	};

	return (
		<section
			aria-label="Messages and chatrooms"
			data-imessage=""
			className="mt-6 overflow-hidden rounded-[14px] border border-line bg-page shadow-[0_8px_28px_-12px_rgba(0,0,0,0.12)] dark:shadow-[0_10px_32px_-12px_rgba(0,0,0,0.45)]"
		>
			<div className="grid min-h-[540px] grid-cols-1 md:grid-cols-[290px_1fr] lg:grid-cols-[320px_1fr]">
				{/* Left Pane: iMessage Conversation List Sidebar */}
				<aside className="flex flex-col border-b border-line bg-sidebar/75 md:border-r md:border-b-0">
					{/* Top Window Bar & Filter Tabs */}
					<div className="flex items-center justify-between gap-2 border-b border-line/80 px-3.5 py-2.5">
						<div className="flex items-center gap-1 rounded-[8px] bg-hover p-0.5 text-[12px] font-medium" role="tablist" aria-label="Conversation filter">
							{(
								[
									["all", "All"],
									["dm", "Direct"],
									["rooms", "Rooms"],
								] as const
							).map(([key, label]) => (
								<button
									key={key}
									type="button"
									role="tab"
									aria-selected={filter === key}
									onClick={() => setFilter(key)}
									data-imessage-filter={key}
									className={cx(
										"rounded-[6px] px-2.5 py-1 transition-colors",
										filter === key ? "bg-page text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-ink",
									)}
								>
									{label}
								</button>
							))}
						</div>
						<button
							type="button"
							onClick={() => {
								setCreatingRoom((v) => !v);
								setRoomFormError(null);
							}}
							data-imessage-new-room=""
							aria-expanded={creatingRoom}
							className="inline-flex h-7 items-center gap-1 rounded-full bg-[#007AFF] px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 dark:bg-[#0A84FF]"
						>
							<span>+ Room</span>
						</button>
					</div>

					{/* Search Input */}
					<div className="border-b border-line/70 px-3 py-2">
						<div className="flex h-7 items-center gap-1.5 rounded-[8px] border border-line bg-page px-2 text-[12.5px] text-muted focus-within:border-[#007AFF] dark:focus-within:border-[#0A84FF]">
							<Icon name="search" size={13} className="shrink-0" />
							<input
								type="search"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search agents, repos, #rooms…"
								aria-label="Search conversations"
								className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted"
							/>
						</div>
					</div>

					{/* Inline New Room Sheet */}
					{creatingRoom && (
						<div className="border-b border-line bg-page p-3" data-imessage-room-form="">
							<div className="text-[12.5px] font-semibold text-ink">New Topic Chatroom</div>
							<p className="mt-0.5 text-[11.5px] text-muted">
								Sync agents working across different repositories on the same topic.
							</p>
							<label htmlFor={roomNameId} className="mt-2 block text-[11.5px] font-medium text-muted">
								Room name
							</label>
							<input
								id={roomNameId}
								type="text"
								value={newRoomName}
								onChange={(e) => setNewRoomName(e.target.value)}
								placeholder="e.g. auth-sync or release-v2"
								className="mt-0.5 block w-full rounded-[6px] border border-line bg-sidebar px-2 py-1 text-[13px] text-ink outline-none focus:border-[#007AFF]"
							/>
							<label htmlFor={roomTopicId} className="mt-2 block text-[11.5px] font-medium text-muted">
								Topic (optional)
							</label>
							<input
								id={roomTopicId}
								type="text"
								value={newRoomTopic}
								onChange={(e) => setNewRoomTopic(e.target.value)}
								placeholder="What are these agents coordinating?"
								className="mt-0.5 block w-full rounded-[6px] border border-line bg-sidebar px-2 py-1 text-[12.5px] text-ink outline-none focus:border-[#007AFF]"
							/>
							{sessions.length > 0 && (
								<div className="mt-2">
									<div className="text-[11.5px] font-medium text-muted">Add online agents</div>
									<ul className="mt-1 max-h-28 space-y-1 overflow-y-auto rounded-[6px] border border-line bg-sidebar p-1.5">
										{sessions.map((s) => {
											const checked = newRoomMembers.has(s.id);
											return (
												<li key={s.id}>
													<label className="flex cursor-pointer items-center gap-2 rounded-[4px] px-1.5 py-1 text-[12px] hover:bg-hover">
														<input
															type="checkbox"
															checked={checked}
															onChange={() =>
																setNewRoomMembers((prev) => {
																	const next = new Set(prev);
																	if (!next.delete(s.id)) next.add(s.id);
																	return next;
																})
															}
															className="accent-[#007AFF]"
														/>
														<span className="truncate font-medium text-ink">{sessionLabel(s)}</span>
														<span className="ml-auto shrink-0 rounded-full bg-page px-1.5 py-0.5 text-[10.5px] text-muted">
															{s.project || "—"}
														</span>
													</label>
												</li>
											);
										})}
									</ul>
								</div>
							)}
							{roomFormError && <div className="mt-1.5 text-[11.5px] text-red">{roomFormError}</div>}
							<div className="mt-2.5 flex items-center justify-end gap-1.5">
								<button
									type="button"
									onClick={() => setCreatingRoom(false)}
									className="rounded-[6px] px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={() => void handleCreateRoom()}
									disabled={savingRoom || !newRoomName.trim()}
									data-imessage-create-room=""
									className="rounded-[6px] bg-[#007AFF] px-3 py-1 text-[12px] font-medium text-white disabled:opacity-45 dark:bg-[#0A84FF]"
								>
									{savingRoom ? "Creating…" : "Create"}
								</button>
							</div>
						</div>
					)}

					{/* Thread List */}
					<ul className="flex-1 divide-y divide-line/60 overflow-y-auto" data-imessage-threads="">
						{filteredThreads.length === 0 ? (
							<li className="px-4 py-10 text-center text-[12.5px] text-muted">
								No active conversations. Start a pi session or click <strong>+ Room</strong> to open a topic room.
							</li>
						) : (
							filteredThreads.map((item) => {
								const selected = resolvedKey === item.key;
								if (item.kind === "room") {
									const repos = [...new Set(item.room.members.map((m) => m.project).filter(Boolean))];
									return (
										<li key={item.key}>
											<button
												type="button"
												onClick={() => setActiveThread({ kind: "room", room: item.room.name })}
												data-imessage-thread={`room:${item.room.name}`}
												aria-current={selected ? "true" : undefined}
												className={cx(
													"flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
													selected
														? "bg-[#007AFF] text-white dark:bg-[#0A84FF]"
														: "hover:bg-hover/80",
												)}
											>
												<div
													className={cx(
														"flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold",
														selected
															? "bg-white/20 text-white"
															: "bg-[#007AFF]/12 text-[#007AFF] dark:bg-[#0A84FF]/20 dark:text-[#5AC8FA]",
													)}
												>
													#
												</div>
												<div className="min-w-0 flex-1">
													<div className="flex items-baseline justify-between gap-1">
														<span className="truncate text-[13.5px] font-semibold">
															#{item.room.name}
														</span>
														<span
															className={cx(
																"tnum shrink-0 text-[11px]",
																selected ? "text-white/80" : "text-muted",
															)}
														>
															{item.room.members.length} {item.room.members.length === 1 ? "agent" : "agents"}
														</span>
													</div>
													{repos.length > 0 && (
														<div
															className={cx(
																"truncate text-[11px] font-medium",
																selected ? "text-white/85" : "text-ink/75",
															)}
														>
															{repos.join(" · ")}
														</div>
													)}
													<div
														className={cx(
															"mt-0.5 truncate text-[12px]",
															selected ? "text-white/80" : "text-muted",
														)}
													>
														{item.preview}
													</div>
												</div>
											</button>
										</li>
									);
								}

								return (
									<li key={item.key}>
										<button
											type="button"
											onClick={() => setActiveThread({ kind: "dm", sessionId: item.sessionId })}
											data-imessage-thread={`dm:${item.sessionId}`}
											aria-current={selected ? "true" : undefined}
											className={cx(
												"flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
												selected
													? "bg-[#007AFF] text-white dark:bg-[#0A84FF]"
													: "hover:bg-hover/80",
											)}
										>
											<div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/10 text-[12px] font-bold dark:bg-white/15">
												<span className={selected ? "text-white" : "text-ink"}>
													{monogram(item.label)}
												</span>
												<span
													aria-hidden="true"
													className={cx(
														"absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2",
														selected ? "ring-[#007AFF] dark:ring-[#0A84FF]" : "ring-sidebar",
														item.state === "busy"
															? "animate-pulse bg-[#FF9500]"
															: item.online
																? "bg-[#34C759]"
																: "bg-muted/50",
													)}
												/>
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex items-baseline justify-between gap-1">
													<span className="truncate text-[13.5px] font-semibold">
														{item.label}
													</span>
													<span
														className={cx(
															"tnum shrink-0 text-[11px]",
															selected ? "text-white/80" : "text-muted",
														)}
													>
														{item.lastAt ? formatRelative(new Date(item.lastAt).toISOString(), now) : ""}
													</span>
												</div>
												<div
													className={cx(
														"truncate text-[11px] font-medium",
														selected ? "text-white/85" : "text-ink/75",
													)}
												>
													{item.project} · {item.device}
												</div>
												<div
													className={cx(
														"mt-0.5 truncate text-[12px]",
														selected ? "text-white/80" : "text-muted",
													)}
												>
													{item.preview}
												</div>
											</div>
										</button>
									</li>
								);
							})
						)}
					</ul>
				</aside>

				{/* Right Pane: Active iMessage Conversation Canvas */}
				<div className="flex min-h-[500px] flex-col bg-page">
					{!resolvedSelection ? (
						<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#007AFF]/10 text-[#007AFF] dark:bg-[#0A84FF]/20 dark:text-[#5AC8FA]">
								<Icon name="message" size={22} />
							</div>
							<div className="mt-3 text-[15px] font-semibold text-ink">iMessage Relay</div>
							<p className="mt-1 max-w-[38ch] text-[13px] text-muted">
								Select an online agent for 1:1 point-to-point messaging, or create a <strong>#room</strong> to sync agents across repositories.
							</p>
						</div>
					) : resolvedSelection.kind === "room" && activeRoom ? (
						<>
							{/* Chatroom Header */}
							<div data-imessage-header="" className="border-b border-line bg-sidebar/50 px-4 py-3 backdrop-blur-md">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#007AFF] text-[12px] font-bold text-white dark:bg-[#0A84FF]">
												#
											</span>
											<h3 className="truncate text-[15px] font-semibold text-ink" data-imessage-active-title="">
												#{activeRoom.name}
											</h3>
											<span className="rounded-full bg-hover px-2 py-0.5 text-[11.5px] text-muted">
												{activeRoom.members.length} {activeRoom.members.length === 1 ? "member" : "members"}
											</span>
										</div>
										{activeRoom.topic && (
											<p className="mt-0.5 truncate text-[12.5px] text-muted">{activeRoom.topic}</p>
										)}
									</div>
									<div className="flex items-center gap-1.5">
										<button
											type="button"
											onClick={() => setManagingMembers((v) => !v)}
											data-imessage-manage-members=""
											aria-expanded={managingMembers}
											className="rounded-full border border-line bg-page px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-hover"
										>
											{managingMembers ? "Done" : "Members"}
										</button>
										<button
											type="button"
											onClick={() => void handleDeleteRoom(activeRoom.name)}
											data-imessage-delete-room=""
											className="rounded-full border border-line bg-page px-2.5 py-1 text-[12px] text-red hover:bg-red-soft"
										>
											Delete room
										</button>
									</div>
								</div>

								{/* Member Pills Strip */}
								<div className="mt-2 flex flex-wrap items-center gap-1.5" data-imessage-room-members="">
									{activeRoom.members.length === 0 ? (
										<span className="text-[12px] text-muted">
											No members yet. Click <strong>Members</strong> to add agents from any repository.
										</span>
									) : (
										activeRoom.members.map((m: RelayRoomMember) => (
											<span
												key={m.sessionId}
												className="inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-2.5 py-0.5 text-[11.5px]"
												title={`${m.sessionId} · ${m.state}`}
											>
												<span
													className={cx(
														"h-1.5 w-1.5 rounded-full",
														m.state === "busy"
															? "animate-pulse bg-[#FF9500]"
															: m.online
																? "bg-[#34C759]"
																: "bg-muted/50",
													)}
												/>
												<span className="font-medium text-ink">{sessionLabel(m)}</span>
												{m.project && <span className="text-muted">({m.project})</span>}
											</span>
										))
									)}
								</div>

								{/* Expandable Member Manager Drawer */}
								{managingMembers && (
									<div className="mt-3 rounded-[10px] border border-line bg-page p-3" data-imessage-member-drawer="">
										<div className="text-[12px] font-semibold text-ink">
											Manage Room Agents (across repositories)
										</div>
										{sessions.length === 0 ? (
											<div className="mt-1 text-[12px] text-muted">No online sessions right now.</div>
										) : (
											<ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
												{sessions.map((s) => {
													const inRoom = activeRoom.members.some((m) => m.sessionId === s.id);
													const busy = memberBusyId === s.id;
													return (
														<li
															key={s.id}
															className="flex items-center justify-between gap-2 rounded-[8px] border border-line px-2.5 py-1.5 text-[12px]"
														>
															<div className="min-w-0">
																<div className="truncate font-medium text-ink">{sessionLabel(s)}</div>
																<div className="truncate text-[11px] text-muted">
																	{s.project || "—"} · {deviceLabel(s)}
																</div>
															</div>
															<button
																type="button"
																disabled={busy}
																onClick={() => void handleToggleRoomMember(activeRoom.name, s.id, inRoom)}
																data-imessage-toggle-member={s.id}
																className={cx(
																	"shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium",
																	inRoom
																		? "border border-line text-muted hover:text-red"
																		: "bg-[#007AFF] text-white dark:bg-[#0A84FF]",
																)}
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

							{/* Chatroom Bubble Stream */}
							<div
								ref={streamRef}
								data-imessage-stream=""
								className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
							>
								{roomMessages.length === 0 ? (
									<div className="flex h-full flex-col items-center justify-center py-12 text-center text-[13px] text-muted">
										<p>No messages in <strong>#{activeRoom.name}</strong> yet.</p>
										<p className="mt-1 max-w-[44ch] text-[12px]">
											Select <strong>@agent</strong> below to notify and wake specific members, or send without @mentions to log notes in the shared room history.
										</p>
									</div>
								) : (
									roomMessages.map((msg) => {
										const outgoing = msg.from.kind === "web";
										const notifiedLabels = msg.notified.map((t) => sessionLabel(t));
										return (
											<div
												key={msg.id}
												data-imessage-bubble={msg.id}
												className={cx("flex flex-col", outgoing ? "items-end" : "items-start")}
											>
												<div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted">
													<span className="font-medium text-ink/80">{senderMetaLine(msg.from)}</span>
													<span>·</span>
													<span className="tnum" title={formatDateTime(msg.at)}>
														{formatRelative(msg.at, now)}
													</span>
													{msg.urgent && (
														<span className="rounded-full bg-red/15 px-1.5 py-0.2 font-semibold text-red">
															urgent
														</span>
													)}
												</div>
												<div
													className={cx(
														"max-w-[82%] px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
														outgoing
															? "rounded-[18px] rounded-br-[4px] bg-[#007AFF] text-white dark:bg-[#0A84FF]"
															: "rounded-[18px] rounded-bl-[4px] bg-[#E9E9EB] text-[#0B0B0B] dark:bg-[#26262A] dark:text-[#F2F2F7]",
													)}
												>
													{renderBubbleText(msg.text, outgoing)}
												</div>
												<div className="mt-0.5 px-1 text-[11px] text-muted">
													{notifiedLabels.length > 0
														? `Notified @${notifiedLabels.join(", @")}`
														: "Saved to room history (no @mention wakeup)"}
												</div>
											</div>
										);
									})
								)}
							</div>
						</>
					) : activeDm ? (
						<>
							{/* 1:1 Direct Message Header */}
							<div data-imessage-header="" className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sidebar/50 px-4 py-3 backdrop-blur-md">
								<div className="flex min-w-0 items-center gap-2.5">
									<div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/10 text-[12.5px] font-bold text-ink dark:bg-white/15">
										{monogram(activeDm.label)}
										<span
											className={cx(
												"absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-page",
												activeDm.state === "busy"
													? "animate-pulse bg-[#FF9500]"
													: activeDm.online
														? "bg-[#34C759]"
														: "bg-muted/50",
											)}
										/>
									</div>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											{activeDm.recorded ? (
												<Link
													to={`/s/${encodeURIComponent(activeDm.sessionId)}`}
													className="truncate text-[15px] font-semibold text-ink hover:underline"
													data-imessage-active-title=""
												>
													{activeDm.label}
												</Link>
											) : (
												<h3 className="truncate text-[15px] font-semibold text-ink" data-imessage-active-title="">
													{activeDm.label}
												</h3>
											)}
											<span className="mono text-[11.5px] text-muted">{shortId(activeDm.sessionId)}</span>
										</div>
										<div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
											<span>{activeDm.project}</span>
											<span>·</span>
											<span>{activeDm.device}</span>
											{activeDm.model && (
												<>
													<span>·</span>
													<span className="inline-flex items-center gap-1">
														<span className="mono text-[11.5px]">{activeDm.model}</span>
														<ModelMark model={activeDm.model} size={11} />
													</span>
												</>
											)}
										</div>
									</div>
								</div>
								<span
									className={cx(
										"rounded-full px-2.5 py-0.5 text-[11.5px] font-medium",
										activeDm.state === "busy"
											? "bg-[#FF9500]/15 text-[#C93400] dark:text-[#FFB340]"
											: activeDm.online
												? "bg-[#34C759]/15 text-[#1E7E34] dark:text-[#30D158]"
												: "bg-hover text-muted",
									)}
								>
									{activeDm.state === "busy" ? "Busy" : activeDm.online ? "Online · Idle" : "Offline"}
								</span>
							</div>

							{/* 1:1 Direct Message Bubble Stream */}
							<div
								ref={streamRef}
								data-imessage-stream=""
								className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
							>
								{dmEvents.length === 0 ? (
									<div className="flex h-full flex-col items-center justify-center py-12 text-center text-[13px] text-muted">
										<p>Direct iMessage thread with <strong>{activeDm.label}</strong>.</p>
										<p className="mt-1 max-w-[40ch] text-[12px]">
											Messages you send here start a turn in this session; peer-to-peer messages with other agents also appear in this thread.
										</p>
									</div>
								) : (
									dmEvents.map((ev) => {
										const fromWeb = ev.from.kind === "web";
										const fromThisSession = ev.from.kind === "session" && ev.from.sessionId === activeDm.sessionId;
										const peerNote =
											fromThisSession && ev.to.sessionId !== activeDm.sessionId
												? `→ ${sessionLabel(ev.to)}`
												: ev.from.kind === "session" && !fromThisSession
													? `${sessionLabel(ev.from)} → ${activeDm.label}`
													: null;
										return (
											<div
												key={ev.id}
												data-imessage-bubble={ev.id}
												className={cx("flex flex-col", fromWeb ? "items-end" : "items-start")}
											>
												<div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted">
													<span className="font-medium text-ink/80">
														{peerNote ?? senderMetaLine(ev.from)}
													</span>
													<span>·</span>
													<span className="tnum" title={formatDateTime(ev.at)}>
														{formatRelative(ev.at, now)}
													</span>
													{ev.urgent && (
														<span className="rounded-full bg-red/15 px-1.5 py-0.2 font-semibold text-red">
															urgent
														</span>
													)}
												</div>
												<div
													className={cx(
														"max-w-[82%] px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
														fromWeb
															? "rounded-[18px] rounded-br-[4px] bg-[#007AFF] text-white dark:bg-[#0A84FF]"
															: "rounded-[18px] rounded-bl-[4px] bg-[#E9E9EB] text-[#0B0B0B] dark:bg-[#26262A] dark:text-[#F2F2F7]",
													)}
												>
													{renderBubbleText(ev.text, fromWeb)}
												</div>
												<div className="mt-0.5 flex items-center gap-1.5 px-1 text-[11px] text-muted">
													{ev.status === "delivered" && <span>Delivered</span>}
													{ev.status === "queued" && <span>Queued</span>}
													{ev.status === "expired" && <span className="text-red">Expired</span>}
													{ev.status === "rejected" && (
														<span className="text-red">Not Delivered ({shortReason(ev.reason)})</span>
													)}
												</div>
											</div>
										);
									})
								)}
							</div>
						</>
					) : null}

					{/* iMessage Bottom Composer Bar */}
					{resolvedSelection && (
						<div className="border-t border-line bg-sidebar/40 px-4 py-3">
							{/* In Room Mode: @mention notify selector pills */}
							{resolvedSelection.kind === "room" && activeRoom && (
								<div className="mb-2 flex flex-wrap items-center gap-1.5" data-imessage-mention-bar="">
									<span className="text-[11.5px] font-medium text-muted">Notify:</span>
									<button
										type="button"
										onClick={() => toggleMention("all")}
										data-imessage-mention="all"
										aria-pressed={selectedMentions.has("all")}
										className={cx(
											"rounded-full px-2 py-0.5 text-[11.5px] font-medium transition-colors",
											selectedMentions.has("all")
												? "bg-[#007AFF] text-white dark:bg-[#0A84FF]"
												: "border border-line bg-page text-ink hover:bg-hover",
										)}
									>
										@all
									</button>
									{activeRoom.members.map((m) => {
										const active = selectedMentions.has("all") || selectedMentions.has(m.sessionId);
										const label = sessionLabel(m);
										return (
											<button
												key={m.sessionId}
												type="button"
												onClick={() => toggleMention(m.sessionId)}
												data-imessage-mention={m.sessionId}
												aria-pressed={active}
												className={cx(
													"rounded-full px-2 py-0.5 text-[11.5px] font-medium transition-colors",
													active
														? "bg-[#007AFF] text-white dark:bg-[#0A84FF]"
														: "border border-line bg-page text-ink hover:bg-hover",
												)}
											>
												@{label}
												{m.project ? ` (${m.project})` : ""}
											</button>
										);
									})}
									<span className="ml-auto text-[11px] text-muted">
										{selectedMentions.size > 0
											? "Selected @agents will wake up"
											: "Tip: click @agent or type @name to wake them"}
									</span>
								</div>
							)}

							<div className="flex items-end gap-2">
								<button
									type="button"
									onClick={() => setUrgent((v) => !v)}
									aria-pressed={urgent}
									data-imessage-urgent=""
									title="Urgent: steers immediately into a busy session's current turn"
									className={cx(
										"flex h-9 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
										urgent
											? "border-red bg-red text-white"
											: "border-line bg-page text-muted hover:text-ink",
									)}
								>
									<span>!</span>
									<span className="max-sm:sr-only">Urgent</span>
								</button>

								<div className="flex min-w-0 flex-1 items-end rounded-[20px] border border-line bg-page px-3 py-1.5 focus-within:border-[#007AFF] dark:focus-within:border-[#0A84FF]">
									<label htmlFor={composerId} className="sr-only">
										iMessage composer
									</label>
									<textarea
										id={composerId}
										rows={1}
										value={text}
										onChange={(e) => setText(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
												if (e.nativeEvent.isComposing) return;
												e.preventDefault();
												void handleSend();
											}
										}}
										placeholder={
											resolvedSelection.kind === "room"
												? `iMessage #${resolvedSelection.room} (use @name to notify)…`
												: `iMessage ${activeDm?.label ?? "session"}…`
										}
										data-imessage-input=""
										className="max-h-32 min-h-[24px] w-full resize-none bg-transparent text-[13.5px] leading-6 text-ink outline-none placeholder:text-muted"
									/>
								</div>

								<button
									type="button"
									onClick={() => void handleSend()}
									disabled={!canSend}
									data-imessage-send=""
									aria-label="Send iMessage"
									className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#007AFF] text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-35 dark:bg-[#0A84FF]"
								>
									↑
								</button>
							</div>

							{tooLong && (
								<div className="mt-1.5 text-[12px] text-red">
									Message exceeds the 32 KiB limit.
								</div>
							)}
							{sendFeedback && (
								<div
									data-imessage-feedback={sendFeedback.tone}
									className={cx(
										"mt-1.5 text-[12px]",
										sendFeedback.tone === "error" ? "text-red" : "text-muted",
									)}
								>
									{sendFeedback.message}
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
