import { ApiError } from "../../lib/api";
import { deviceLabel } from "../../lib/devices";
import { bareModelOf } from "../../lib/model";
import { plainLine, reasonMessage, sessionLabel, shortId } from "../../lib/relay";
import type {
	OnlineSession,
	RelayEvent,
	RelayRoom,
	RelayRoomMember,
	RelayRoomMessage,
	RelaySender,
	RelayTarget,
	SessionSummary,
} from "../../lib/types";
import type {
	ChatMessage,
	DmThread,
	MentionCandidate,
	PeerState,
	RoomThread,
	ThreadItem,
	ThreadSelection,
} from "./types";

export const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Room history window fetched from the server; auto-scroll must keep firing once a room stays at this cap. */
export const MAX_ROOM_MESSAGES = 150;
/** From this width a long message opens in a reader beside the conversation; below it, Show all expands in place. */
export const READER_QUERY = "(min-width: 1280px)";
/** How close to the bottom the conversation must be for a new message to keep it pinned there. */
export const STICK_PX = 80;
const REFUSED_STATUSES = new Set([400, 403, 404, 409, 429]);

export function formatError(cause: unknown): string {
	if (cause instanceof ApiError && REFUSED_STATUSES.has(cause.status)) {
		return reasonMessage(cause.message);
	}
	return cause instanceof Error ? cause.message : String(cause);
}

export const STATE_WORD: Record<PeerState, string> = { busy: "Busy", idle: "Idle", offline: "Offline" };

export const FIELD =
	"mt-1 block w-full rounded-sm border border-line bg-page px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink";

export function senderName(sender: RelaySender): string {
	return sender.kind === "web" ? "You" : sessionLabel(sender);
}

export function senderWhere(sender: RelaySender): string {
	if (sender.kind === "web") return "";
	return [sender.project, deviceLabel(sender)].filter(Boolean).join(" · ");
}

export function memberDevice(target: { device?: string; deviceName?: string }): string {
	return target.device ? deviceLabel({ device: target.device, deviceName: target.deviceName }) : "";
}

export function names(targets: readonly RelayTarget[]): string {
	return targets.map((target) => sessionLabel(target)).join(", ");
}

export function mentionTokenOf(member: RelayRoomMember): string {
	if (member.name && /^[A-Za-z0-9._-]+$/.test(member.name)) return member.name;
	return member.sessionId;
}

export function threadSelectionKey(selection: ThreadSelection | null): string {
	if (!selection) return "";
	return selection.kind === "room" ? `room:${selection.room}` : `dm:${selection.sessionId}`;
}

export function buildThreads({
	sessions,
	events,
	rooms,
	requestedDmId,
	dmSession,
}: {
	sessions: readonly OnlineSession[];
	events: readonly RelayEvent[];
	rooms: readonly RelayRoom[];
	requestedDmId: string | null;
	dmSession?: SessionSummary;
}): ThreadItem[] {
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
		dmMap.set(requestedDmId, {
			kind: "dm",
			key: `dm:${requestedDmId}`,
			sessionId: requestedDmId,
			label: dmSession ? sessionLabel(dmSession) : shortId(requestedDmId),
			named: Boolean(dmSession?.title),
			device: dmSession ? deviceLabel(dmSession) : "",
			project: dmSession?.project || "—",
			model: dmSession?.models[0] ? bareModelOf(dmSession.models[0]) : undefined,
			state: "offline",
			recorded: Boolean(dmSession),
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
}

export function filterThreads(threads: readonly ThreadItem[], search: string): ThreadItem[] {
	const q = search.trim().toLowerCase().replace(/^#/, "");
	if (!q) return [...threads];
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
}

export function buildChatMessages({
	selection,
	roomMessages,
	events,
}: {
	selection: ThreadSelection | null;
	roomMessages?: readonly RelayRoomMessage[];
	events: readonly RelayEvent[];
}): ChatMessage[] {
	if (selection?.kind === "room") {
		const posts = roomMessages ?? [];
		return posts.map((m) => ({
			id: m.id,
			seq: m.seq,
			at: m.at,
			from: m.from,
			notified: m.notified,
			urgent: m.urgent,
			replyTo: m.replyTo,
			hops: m.hops,
			text: m.text,
		}));
	}
	if (selection?.kind !== "dm") return [];
	const sid = selection.sessionId;
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
}

export function detectActiveMention(
	text: string,
	cursorPos: number,
	dismissedMentionAt: number | null,
): { query: string; atIndex: number } | null {
	const before = text.slice(0, cursorPos);
	const match = /(?:^|[\s([{"',:;])@([A-Za-z0-9._-]*)$/.exec(before);
	if (!match) return null;
	const query = match[1]!;
	const atIndex = before.length - query.length - 1;
	if (dismissedMentionAt === atIndex) return null;
	return { query, atIndex };
}

export function buildMentionCandidates(room: RelayRoom, query: string): MentionCandidate[] {
	const q = query.toLowerCase();
	const all: MentionCandidate[] = [
		{ token: "all", label: "Everyone", detail: "Wake all room members", representative: false },
		...room.members.map((m) => ({
			token: mentionTokenOf(m),
			label: sessionLabel(m),
			detail: [m.project, memberDevice(m)].filter(Boolean).join(" · "),
			representative: m.sessionId === room.representative,
		})),
	];
	if (!q) return all;
	return all.filter(
		(item) =>
			item.token.toLowerCase().includes(q)
			|| item.label.toLowerCase().includes(q)
			|| item.detail.toLowerCase().includes(q),
	);
}
