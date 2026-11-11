import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useSigningOut } from "../components/Layout";
import { Messenger, type ThreadSelection } from "../components/Messenger";
import { ErrorState, Page, PageTitle, SkeletonLines } from "../components/ui";
import { useApi } from "../lib/api";
import { useNow } from "../lib/hooks";
import {
	isRelayDisabled,
	relayAvailability,
	RELAY_EVENTS_KEY,
	RELAY_POLL_MS,
	RELAY_ROOMS_KEY,
	RELAY_SESSIONS_KEY,
	useOnlineSessions,
} from "../lib/relay";
import { RelayOff } from "./ActiveSessions";

const CLOCK_MS = 10_000;

export function ChatroomsPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { room: roomParam } = useParams();
	const [searchParams] = useSearchParams();
	const { signingOut } = useSigningOut();

	const dmParam = !roomParam ? searchParams.get("dm") : null;
	const hasUrlSelection = Boolean(roomParam || dmParam);

	const selectedThread = useMemo<ThreadSelection | null>(() => {
		if (roomParam) return { kind: "room", room: roomParam.replace(/^#/, "") };
		if (dmParam) return { kind: "dm", sessionId: dmParam };
		return null;
	}, [roomParam, dmParam]);

	const handleSelectThread = useCallback(
		(next: ThreadSelection | null) => {
			if (!next) {
				navigate("/chatrooms", { replace: true });
				return;
			}
			if (next.kind === "room") {
				navigate(`/chatrooms/${encodeURIComponent(next.room)}`);
			} else {
				navigate(`/chatrooms?dm=${encodeURIComponent(next.sessionId)}`);
			}
		},
		[navigate],
	);

	const { health, sessions, availability: sessionsAvailability } = useOnlineSessions(signingOut ? false : RELAY_POLL_MS);
	const events = useQuery({
		queryKey: RELAY_EVENTS_KEY,
		queryFn: () => api.relayEvents(),
		enabled: sessionsAvailability === "on" && !signingOut,
		staleTime: 0,
		refetchInterval: (query) => (signingOut || isRelayDisabled(query.state.error) ? false : RELAY_POLL_MS),
	});

	useEffect(() => {
		if (!signingOut) return;
		void queryClient.cancelQueries({ queryKey: RELAY_SESSIONS_KEY });
		void queryClient.cancelQueries({ queryKey: RELAY_EVENTS_KEY });
		void queryClient.cancelQueries({ queryKey: RELAY_ROOMS_KEY });
		void queryClient.cancelQueries({ queryKey: ["relay", "room"] });
	}, [signingOut, queryClient]);

	const availability = relayAvailability(health, sessions.error, events.error);
	const now = useNow(availability === "on", CLOCK_MS);

	if (availability === "loading") {
		return (
			<div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
				<div className="border-b border-ink px-4 py-2.5">
					<h1 className="text-[16px] leading-6 font-semibold tracking-[-0.01em]">Chatrooms</h1>
				</div>
				<div className="p-6">
					<SkeletonLines lines={4} />
				</div>
			</div>
		);
	}

	if (availability === "error") {
		return (
			<Page className="pb-24">
				<PageTitle>Chatrooms</PageTitle>
				<ErrorState error={health.error} onRetry={() => void health.refetch()} />
			</Page>
		);
	}

	if (availability !== "on") {
		return (
			<Page className="pb-24">
				<PageTitle>Chatrooms</PageTitle>
				<RelayOff availability={availability} />
			</Page>
		);
	}

	return (
		<div className="flex h-full min-h-0 w-full flex-col overflow-hidden" data-chatrooms-page="">
			<Messenger
				sessions={sessions.data?.items ?? []}
				events={events.data?.items ?? []}
				now={now}
				selectedThread={selectedThread}
				hasUrlSelection={hasUrlSelection}
				onSelectThread={handleSelectThread}
			/>
		</div>
	);
}
