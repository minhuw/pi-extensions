import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, useApi } from "../../lib/api";
import { isRelayDisabled, RELAY_POLL_MS, RELAY_ROOMS_KEY, relayRoomKey } from "../../lib/relay";
import type { OnlineSession, RelayEvent, RelayRoom } from "../../lib/types";
import { useSigningOut } from "../Layout";
import {
	buildChatMessages,
	buildThreads,
	filterThreads,
	MAX_ROOM_MESSAGES,
	threadSelectionKey,
} from "./helpers";
import type { DmThread, RoomThread, ThreadFilter, ThreadSelection } from "./types";

export function useMessengerData({
	sessions,
	events,
	activeThread,
	hasUrlSelection,
	search,
	filter,
	onCloseDeleteDialog,
	onClearSelection,
}: {
	sessions: readonly OnlineSession[];
	events: readonly RelayEvent[];
	activeThread: ThreadSelection | null;
	hasUrlSelection: boolean;
	search: string;
	filter: ThreadFilter;
	onCloseDeleteDialog: () => void;
	onClearSelection: () => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const { signingOut } = useSigningOut();
	const [memberBusyId, setMemberBusyId] = useState<string | null>(null);

	const roomsQuery = useQuery({
		queryKey: RELAY_ROOMS_KEY,
		queryFn: () => api.relayRooms(),
		enabled: !signingOut,
		staleTime: 0,
		refetchInterval: (query) => (signingOut || isRelayDisabled(query.state.error) ? false : RELAY_POLL_MS),
	});
	const rooms = roomsQuery.data?.items ?? [];

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

	const threads = useMemo(
		() => buildThreads({ sessions, events, rooms, requestedDmId, dmSession: dmSessionQuery.data }),
		[sessions, events, rooms, requestedDmId, dmSessionQuery.data],
	);

	const searchMatchedThreads = useMemo(() => filterThreads(threads, search), [threads, search]);
	const roomMatches = useMemo(
		() => searchMatchedThreads.filter((item): item is RoomThread => item.kind === "room"),
		[searchMatchedThreads],
	);
	const dmMatches = useMemo(
		() => searchMatchedThreads.filter((item): item is DmThread => item.kind === "dm"),
		[searchMatchedThreads],
	);

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
		queryFn: () => api.relayRoom(activeRoomName!, MAX_ROOM_MESSAGES),
		enabled: Boolean(activeRoomName) && !signingOut,
		staleTime: 0,
		refetchInterval: (query) =>
			signingOut
			|| !activeRoomName
			|| isRelayDisabled(query.state.error)
			|| (query.state.error instanceof ApiError && query.state.error.status === 404)
				? false
				: RELAY_POLL_MS,
	});

	const resolvedKey = threadSelectionKey(resolvedSelection);
	const resolvedKeyRef = useRef(resolvedKey);
	useLayoutEffect(() => {
		resolvedKeyRef.current = resolvedKey;
	}, [resolvedKey]);

	const activeRoom: RelayRoom | undefined = useMemo(() => {
		if (resolvedSelection?.kind !== "room") return undefined;
		return roomDetailQuery.data?.room ?? rooms.find((r) => r.name === resolvedSelection.room);
	}, [resolvedSelection, roomDetailQuery.data, rooms]);

	const activeDm: DmThread | undefined = useMemo(() => {
		if (resolvedSelection?.kind !== "dm") return undefined;
		return threads.find((t): t is DmThread => t.kind === "dm" && t.sessionId === resolvedSelection.sessionId);
	}, [resolvedSelection, threads]);

	const messages = useMemo(
		() => buildChatMessages({ selection: resolvedSelection, roomMessages: roomDetailQuery.data?.messages, events }),
		[resolvedSelection, roomDetailQuery.data, events],
	);
	const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

	const handleToggleRoomMember = async (roomName: string, sessionId: string, isMember: boolean) => {
		setMemberBusyId(sessionId);
		try {
			await api.setRelayRoomMember(roomName, { sessionId, action: isMember ? "remove" : "add" });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(roomName) }),
			]);
		} finally {
			setMemberBusyId((current) => (current === sessionId ? null : current));
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
			setMemberBusyId((current) => (current === sessionId ? null : current));
		}
	};

	const handleDeleteRoom = async (roomName: string) => {
		const targetKey = `room:${roomName}`;
		await api.deleteRelayRoom(roomName);
		if (resolvedKeyRef.current === targetKey) {
			onCloseDeleteDialog();
		}
		queryClient.removeQueries({ queryKey: relayRoomKey(roomName) });
		await queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY });
		if (resolvedKeyRef.current === targetKey) {
			onClearSelection();
		}
	};

	const onlineById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
	const canLinkSession = (sessionId: string): boolean => {
		const online = onlineById.get(sessionId);
		if (online) return online.recorded;
		if (dmSessionQuery.data?.id === sessionId) return true;
		if (activeRoom?.members.some((m) => m.sessionId === sessionId)) return true;
		return false;
	};

	const roomsError = roomsQuery.isError && !isRelayDisabled(roomsQuery.error) ? roomsQuery.error : null;
	const roomDetailIs404 = roomDetailQuery.error instanceof ApiError && roomDetailQuery.error.status === 404;
	const roomLoadError =
		resolvedSelection?.kind === "room" && roomDetailQuery.isError && !isRelayDisabled(roomDetailQuery.error)
			? roomDetailQuery.error
			: null;
	const dmLoadError =
		resolvedSelection?.kind === "dm"
		&& dmSessionQuery.isError
		&& !(dmSessionQuery.error instanceof ApiError && dmSessionQuery.error.status === 404)
			? dmSessionQuery.error
			: null;

	const missingRoomName =
		resolvedSelection?.kind === "room"
		&& !activeRoom
		&& !roomsQuery.isPending
		&& !roomDetailQuery.isPending
		&& (!roomLoadError || roomDetailIs404)
			? resolvedSelection.room
			: null;

	return {
		roomsQuery,
		dmSessionQuery,
		roomDetailQuery,
		threads,
		searchMatchedThreads,
		roomMatches,
		dmMatches,
		visibleThreads,
		resolvedSelection,
		resolvedKey,
		resolvedKeyRef,
		activeRoom,
		activeDm,
		messages,
		messagesById,
		memberBusyId,
		canLinkSession,
		roomsError,
		roomLoadError,
		dmLoadError,
		missingRoomName,
		handleToggleRoomMember,
		handleToggleRepresentative,
		handleDeleteRoom,
	};
}
