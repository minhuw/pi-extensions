/**
 * `/relay log`: the relay messages of the current branch, read from its `relay-received` and
 * `relay-sent` entries, in the shared log viewer. Also the labels the transcript renderers share
 * with it, and `size`, re-exported. Every field shown comes from another device or the model.
 */
import type { ExtensionCommandContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { localTime, LogViewer, type LogView, type LogViewItem, showLog, size } from "../log-viewer.ts";
import { deviceLabel, headerField, RECEIVED_TYPE, sanitize } from "./protocol.ts";

export { size } from "../log-viewer.ts";

export const SENT_TYPE = "relay-sent";

/** A `relay-sent` entry: one message the server accepted from this session. */
export interface RelaySentData {
	id: string; to?: string; room?: string; label?: string; mentions?: string[]; text: string; replyTo?: string; urgent: boolean; status: "delivered" | "queued"; at: string;
}

/** "name on device · project" for a session; each part is optional except the name, else the id. */
export function peerLabel(peer: { sessionId?: unknown; name?: unknown; title?: unknown; device?: unknown; deviceName?: unknown; project?: unknown } | undefined): string {
	const device = deviceLabel(peer);
	const project = headerField(peer?.project);
	return `${headerField(peer?.name) || headerField(peer?.title) || headerField(peer?.sessionId) || "an unknown session"}${device ? ` on ${device}` : ""}${project ? ` · ${project}` : ""}`;
}

export const senderLabel = (sender: { kind?: unknown } | undefined): string =>
	sender?.kind === "web" ? "your user, from the pika web UI" : peerLabel(sender as Parameters<typeof peerLabel>[0]);

export interface LogItem { incoming: boolean; id: string; at: string; peer: string; room?: string; mentions?: string[]; replyTo?: string; urgent: boolean; status?: string; text: string }

/** The relay messages of `entries` in order; `live` gives a sent message's latest status in this process. */
export function logItems(entries: readonly SessionEntry[], live: (id: string) => string | undefined = () => undefined): LogItem[] {
	const items: LogItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || (entry.customType !== RECEIVED_TYPE && entry.customType !== SENT_TYPE)) continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (typeof data?.text !== "string") continue;
		const incoming = entry.customType === RECEIVED_TYPE;
		const id = headerField(data.id);
		const room = headerField(data.room).replace(/^#/, "") || undefined;
		const mentions = Array.isArray(data.mentions) ? data.mentions.map(headerField).filter(Boolean) : [];
		const replyTo = headerField(data.replyTo) || undefined;
		items.push({
			incoming, id, at: typeof data.at === "string" ? data.at : entry.timestamp, urgent: data.urgent === true, text: sanitize(data.text),
			peer: incoming ? senderLabel(data.from as { kind?: unknown } | undefined) : room ? "" : headerField(data.label) || headerField(data.to) || "an unknown session",
			...(room ? { room } : {}), ...(mentions.length ? { mentions } : {}), ...(replyTo ? { replyTo } : {}),
			...(incoming ? {} : { status: (id && live(id)) || headerField(data.status) || "sent" }),
		});
	}
	return items;
}

const STATUS_COLOR: Record<string, "success" | "warning" | "error"> = { delivered: "success", queued: "warning", expired: "error" };

/** The relay log's items as the log viewer shows them. */
export function relayView(theme: Theme, items: readonly LogItem[]): LogView {
	const who = (item: LogItem) => [item.peer && theme.bold(item.peer), item.room && theme.fg("accent", `#${item.room}`)].filter(Boolean).join(" ");
	const status = (item: LogItem) => item.status ? theme.fg(STATUS_COLOR[item.status] ?? "muted", item.status) : "";
	return {
		title: "✉ relay log",
		noun: ["message", "messages"],
		items: items.map((item): LogViewItem => {
			const arrow = item.incoming ? theme.fg("accent", "←") : theme.fg("muted", "→");
			return {
				at: item.at, icon: arrow,
				parts: [who(item), status(item), theme.fg("dim", size(item.text))],
				heading: `${arrow} ${item.incoming ? "from" : "to"} ${who(item)}`,
				fields: [
					["Time", localTime(item.at, true)],
					["Id", item.id],
					["Mentions", item.mentions?.join(", ")],
					["Reply to", item.replyTo],
					["Urgent", item.urgent ? theme.fg("warning", "yes") : undefined],
					["Status", status(item)],
					["Size", size(item.text)],
				],
				text: item.text,
			};
		}),
	};
}

/** The relay log as a component. */
export class RelayLog extends LogViewer {
	constructor(tui: ConstructorParameters<typeof LogViewer>[0], theme: Theme, keys: ConstructorParameters<typeof LogViewer>[2], items: readonly LogItem[], done: () => void) {
		super(tui, theme, keys, relayView(theme, items), done);
	}
}

/** Opens the log over the transcript until Esc or q closes it. */
export async function showRelayLog(context: ExtensionCommandContext, items: readonly LogItem[]): Promise<void> {
	await showLog(context, (theme) => relayView(theme, items));
}
