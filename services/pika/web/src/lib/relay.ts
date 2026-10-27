// Relay on the web: availability, the shared queries, and labels for sessions and messages (docs/RELAY.md).
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, useApi } from "./api";
import { deviceLabel } from "./devices";
import { formatDuration } from "./format";
import type { Health, OnlineSession, RelayRejection, RelaySender, RelayTarget } from "./types";

/** How often the Active sessions page polls sessions and messages while visible. */
export const RELAY_POLL_MS = 3_000;
/** How often the sidebar badge and the session page refresh the online sessions elsewhere. */
export const RELAY_BADGE_POLL_MS = 15_000;
/** How often health is asked again while it is failing, after its quick retries; it hides the sidebar item meanwhile. */
export const HEALTH_RETRY_MS = 30_000;
/** Quick retries of a failed health request, with TanStack's exponential backoff (1 s, 2 s). */
const HEALTH_RETRIES = 2;
/** The server's limit on message text, in UTF-8 bytes. */
export const MAX_TEXT_BYTES = 32 * 1024;

export const HEALTH_KEY = ["health"] as const;
export const RELAY_SESSIONS_KEY = ["relay", "sessions"] as const;
export const RELAY_EVENTS_KEY = ["relay", "events"] as const;

/**
 * `on`, or why the dashboard can't show anything: `off` when the server runs with `PIKA_RELAY=off`, `unsupported`
 * when it is older than relay, `loading` and `error` while health is unknown.
 */
export type RelayAvailability = "loading" | "error" | "on" | "off" | "unsupported";

/** A 404 `relay_disabled`, which every relay route answers when relay is off. */
export function isRelayDisabled(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404 && error.message === "relay_disabled";
}

export function relayAvailability(health: UseQueryResult<Health>, ...errors: unknown[]): RelayAvailability {
	if (health.isPending) return "loading";
	if (!health.data) return "error";
	if (!Array.isArray(health.data.features)) return "unsupported";
	if (!health.data.features.includes("relay")) return "off";
	return errors.some(isRelayDisabled) ? "off" : "on";
}

export function useHealth(): UseQueryResult<Health> {
	const api = useApi();
	// Window-focus refetches are off, so a failed request would otherwise stand until something else refetches.
	return useQuery({
		queryKey: HEALTH_KEY,
		queryFn: () => api.health(),
		staleTime: 5 * 60_000,
		retry: HEALTH_RETRIES,
		refetchInterval: (query) => (query.state.status === "error" ? HEALTH_RETRY_MS : false),
	});
}

/**
 * The online sessions, polled every `pollMs` (paused while the tab is hidden, and never once relay answers
 * `relay_disabled`). Observers that pass `false` read what another one polls.
 */
export function useOnlineSessions(pollMs: number | false) {
	const api = useApi();
	const health = useHealth();
	const enabled = health.data?.features?.includes("relay") === true;
	const sessions = useQuery({
		queryKey: RELAY_SESSIONS_KEY,
		queryFn: () => api.relaySessions(),
		enabled,
		staleTime: pollMs === false ? RELAY_BADGE_POLL_MS : 0,
		refetchInterval: (query) => (pollMs === false || isRelayDisabled(query.state.error) ? false : pollMs),
	});
	return { health, sessions, availability: relayAvailability(health, sessions.error) };
}

const REASONS: Record<string, { short: string; long: string }> = {
	invalid: { short: "invalid", long: "The message is empty or the session id is not valid." },
	self: { short: "sent to itself", long: "A session can't message itself." },
	too_large: { short: "too large", long: "The message is too long: the limit is 32 KiB." },
	rate_limited: { short: "rate limited", long: "Too many messages in the last minute. Wait a moment and try again." },
	hop_limit: { short: "too many hops", long: "The message went through more than 8 sessions without the user." },
	unknown_session: { short: "unknown session", long: "pika doesn't know this session: it is offline and was never uploaded." },
	mailbox_full: { short: "mailbox full", long: "Too many messages are waiting to be delivered. Try again later." },
	relay_disabled: { short: "relay off", long: "Relay is turned off on this server." },
};

/** A rejection reason as a few words, for a status badge. */
export function shortReason(reason: RelayRejection | undefined): string {
	if (!reason) return "unknown reason";
	return REASONS[reason]?.short ?? reason.replace(/_/g, " ");
}

/** A rejection reason as a sentence, for the composer. */
export function reasonMessage(reason: string): string {
	return REASONS[reason]?.long ?? `The server refused the message: ${reason}.`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID's first 8 characters; any other id in full, since a cut one reads as broken ("no-such-"). */
export function shortId(id: string): string {
	return UUID.test(id) ? id.slice(0, 8) : id;
}

/** What a session is called: its name, its title, or its id, cut short when it is a UUID. */
export function sessionLabel(session: { id?: string; sessionId?: string; name?: string; title?: string }): string {
	return session.name || session.title || shortId(session.id ?? session.sessionId ?? "");
}

export function senderLabel(sender: RelaySender): string {
	return sender.kind === "web" ? "You (web)" : `${sessionLabel(sender)} on ${deviceLabel(sender)}`;
}

export function targetLabel(target: RelayTarget): string {
	const label = sessionLabel(target);
	return target.device ? `${label} on ${deviceLabel({ device: target.device, deviceName: target.deviceName })}` : label;
}

/**
 * Online sessions by device id, devices by name (case-insensitively, then id), and within one the oldest connection
 * first, so newcomers append. A group's name is its newest session's, in case a rename lands between them.
 */
export function groupByDevice(items: readonly OnlineSession[]): { device: string; name: string; sessions: OnlineSession[] }[] {
	const groups = new Map<string, OnlineSession[]>();
	for (const item of items) {
		const group = groups.get(item.device);
		if (group) group.push(item);
		else groups.set(item.device, [item]);
	}
	return [...groups.entries()]
		.map(([device, sessions]) => {
			sessions.sort((a, b) => Date.parse(a.connectedAt) - Date.parse(b.connectedAt) || a.id.localeCompare(b.id));
			return { device, name: deviceLabel(sessions[sessions.length - 1]), sessions };
		})
		.sort((a, b) => {
			const x = a.name.toLowerCase();
			const y = b.name.toLowerCase();
			return x < y ? -1 : x > y ? 1 : a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
		});
}

/** How long ago `since` was, to the minute: "<1m", "12m", "1h 5m". */
export function formatSince(since: string, now: number): string {
	const ms = now - Date.parse(since);
	if (!Number.isFinite(ms)) return "—";
	if (ms < 60_000) return "<1m";
	return formatDuration(Math.floor(ms / 60_000) * 60_000);
}

export function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** A key that changes when items come or go, for the layout guard. */
export function idsKey(items: readonly { id: string }[] | undefined): string | undefined {
	return items?.map((item) => item.id).sort().join(" ");
}
