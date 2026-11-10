/** Tool result lines, as the Pi relay tools word them (`extensions/pika/relay/index.ts`). */
import {
    deviceLabel, headerField, type OnlineSession, type RelayRoom, type RoomMember, type RoomMessage, sanitize, type SentFrame, since, targetLabel, ttlText,
} from "../../../extensions/pika/relay/protocol.ts";

export const REJECTIONS: Record<string, string> = {
    invalid: "the message is invalid: empty text, a malformed session id, or bad hops",
    self: "that is this session's own id",
    too_large: "the text is too large",
    rate_limited: "this session sent too many messages in the last minute; wait before sending more",
    unknown_session: "no online or recorded pi session has that id; call relay_list for the online sessions",
    mailbox_full: "the target's mailbox is full; try again later",
    // Codex has no /relay commands: a thread is added to rooms in the pika web UI.
    unknown_room: "no such chatroom; your user creates rooms in the pika web UI",
    not_member: "this session is not a member of that room; only your user can add it, in the pika web UI",
};

export const rejection = (reason: string, maxHops: number): string | undefined => reason === "hop_limit"
    ? `the message would travel more than ${maxHops} hops between sessions without the user; stop relaying and wait for your user`
    : REJECTIONS[reason];

export const preview = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 60 ? `${line.slice(0, 59)}…` : line; };

/** One online session; every field comes from another device. */
export function sessionLine(session: OnlineSession): string {
    const name = headerField(session.name) || headerField(session.title);
    return [
        headerField(session.id), deviceLabel(session), `project ${headerField(session.project)}`, name ? `"${name}"` : "untitled", headerField(session.state),
        headerField(session.model) || "no model", `online ${since(session.connectedAt)}`,
    ].join(" · ");
}

export function memberLabel(member: RoomMember): string {
    const name = headerField(member.name) || headerField(member.title) || headerField(member.sessionId);
    const project = headerField(member.project);
    return `${name}${project ? ` (${project})` : ""} [${headerField(member.sessionId)}, ${headerField(member.state)}]`;
}

export function roomLine(room: RelayRoom): string {
    const topic = headerField(room.topic);
    const members = room.members.map(memberLabel).join(", ") || "no members";
    return `#${headerField(room.name)}${topic ? ` — ${topic}` : ""} · ${room.messageCount} msg${room.messageCount === 1 ? "" : "s"} · members: ${members}`;
}

export function roomMessageLine(msg: RoomMessage): string {
    const sender = msg.from.kind === "web"
        ? "user (web)"
        : `${headerField(msg.from.name) || headerField(msg.from.title) || headerField(msg.from.sessionId)}${msg.from.project ? ` (${headerField(msg.from.project)})` : ""}`;
    const mentions = msg.mentions?.length ? ` [notified: ${msg.mentions.map(headerField).join(", ")}]` : "";
    return `[#${msg.seq} · ${headerField(msg.id)} · ${since(msg.at)} ago] ${sender}${mentions}: ${sanitize(msg.text)}`;
}

export function sendResult(answer: SentFrame & { status: "delivered" | "queued"; unmatched?: string[] }, label: string, ttlSeconds: number): string {
    if (answer.room) {
        const notified = answer.notified ?? [];
        const who = notified.length
            ? `notified ${notified.map((t) => targetLabel(t)).join(", ")}`
            : "recorded in room history (no @mentions notified)";
        const unmatched = Array.isArray(answer.unmatched) ? answer.unmatched.map(headerField).filter(Boolean) : [];
        const nobody = unmatched.length ? ` These mentions reached nobody, as they are not members: ${unmatched.join(", ")}.` : "";
        return `Posted message ${answer.id} to room #${headerField(answer.room)} (${who}).${nobody}`;
    }
    if (answer.status === "delivered") return `Delivered message ${answer.id} to ${label}.`;
    return `Queued message ${answer.id} for ${label}: it has not been delivered yet. If it is not delivered within ${ttlText(ttlSeconds)} it is dropped and you will get a notice.`;
}
