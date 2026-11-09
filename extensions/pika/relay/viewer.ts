/**
 * `/relay log`: the relay messages of the current branch, read from its `relay-received` and
 * `relay-sent` entries, in a list that opens each one in full. Also the labels and sizes the
 * transcript renderers share with it. Every field shown comes from another device or the model.
 */
import type { ExtensionCommandContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, matchesKey, type OverlayOptions, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { deviceLabel, headerField, RECEIVED_TYPE, sanitize } from "./protocol.ts";

export const SENT_TYPE = "relay-sent";

/** A `relay-sent` entry: one message the server accepted from this session. */
export interface RelaySentData {
	id: string; to?: string; room?: string; label?: string; mentions?: string[]; text: string; replyTo?: string; urgent: boolean; status: "delivered" | "queued"; at: string;
}

/** "42 chars" below 1000, "1.2k chars" below 10 000, then "12k chars". */
export function size(text: string): string {
	const count = [...text].length;
	if (count < 1000) return `${count} char${count === 1 ? "" : "s"}`;
	const thousands = count / 1000;
	return `${thousands < 9.95 ? Math.round(thousands * 10) / 10 : Math.round(thousands)}k chars`;
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

const two = (value: number) => String(value).padStart(2, "0");
function localTime(at: string, seconds = false): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return seconds ? "unknown time" : "--:--";
	const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
	return seconds ? `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${clock}:${two(date.getSeconds())}` : clock;
}

const CHROME = 6;
const STATUS_COLOR: Record<string, "success" | "warning" | "error"> = { delivered: "success", queued: "warning", expired: "error" };

export class RelayLog implements Component {
	private selected: number;
	private top = 0;
	private open: LogItem | undefined;
	private scroll = 0;
	private maxScroll = 0;

	constructor(
		private readonly tui: Pick<TUI, "mode" | "requestRender"> & { terminal: { rows: number } },
		private readonly theme: Theme,
		private readonly keys: Pick<KeybindingsManager, "matches"> | undefined,
		private readonly items: readonly LogItem[],
		private readonly done: () => void,
	) {
		this.selected = Math.max(0, items.length - 1);
	}

	invalidate(): void {}

	/** Rows of the list or text between the header and the footer. */
	private height(): number {
		const rows = Math.max(0, this.tui.terminal.rows);
		return Math.max(3, (this.tui.mode === "fullscreen" ? rows : Math.floor(rows * 0.7)) - CHROME);
	}

	handleInput(data: string): void {
		const is = (id: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown" | "tui.select.confirm" | "tui.select.cancel", fallback: "up" | "down" | "pageUp" | "pageDown" | "enter" | "escape") =>
			this.keys ? this.keys.matches(data, id) : matchesKey(data, fallback);
		let move = 0;
		if (is("tui.select.cancel", "escape") || matchesKey(data, "q")) {
			if (!this.open) { this.done(); return; }
			this.open = undefined;
		} else if (!this.open && is("tui.select.confirm", "enter")) {
			this.open = this.items[this.selected];
			this.scroll = 0;
		} else if (is("tui.select.up", "up")) move = -1;
		else if (is("tui.select.down", "down")) move = 1;
		else if (is("tui.select.pageUp", "pageUp")) move = -this.height();
		else if (is("tui.select.pageDown", "pageDown")) move = this.height();
		else if (matchesKey(data, "home")) move = -Infinity;
		else if (matchesKey(data, "end")) move = Infinity;
		else return;
		if (this.open) this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + move));
		else this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + move));
		this.tui.requestRender();
	}

	private who(item: LogItem): string {
		return [item.peer && this.theme.bold(item.peer), item.room && this.theme.fg("accent", `#${item.room}`)].filter(Boolean).join(" ");
	}

	private status(item: LogItem): string {
		return item.status ? this.theme.fg(STATUS_COLOR[item.status] ?? "muted", item.status) : "";
	}

	private arrow(item: LogItem): string {
		return item.incoming ? this.theme.fg("accent", "←") : this.theme.fg("muted", "→");
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(1, width - 4);
		const height = this.height();
		const row = (text: string) => `${th.fg("border", "│")} ${truncateToWidth(text, inner, "…", true)} ${th.fg("border", "│")}`;
		const rule = (left: string, right: string) => th.fg("border", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
		let title: string;
		let body: string[];
		let hint: string;
		if (!this.open) {
			if (this.selected < this.top) this.top = this.selected;
			if (this.selected >= this.top + height) this.top = this.selected - height + 1;
			this.top = Math.max(0, Math.min(this.top, this.items.length - height));
			const count = this.items.length;
			title = `${th.fg("accent", "✉ relay log")} ${th.fg("dim", `· ${count} message${count === 1 ? "" : "s"} on this branch`)}`;
			body = this.items.slice(this.top, this.top + height).map((item, index) => {
				const mark = this.top + index === this.selected ? th.fg("accent", "▸") : " ";
				const parts = [this.who(item), this.status(item), th.fg("dim", size(item.text))].filter(Boolean);
				return `${mark} ${this.arrow(item)} ${th.fg("dim", localTime(item.at))}  ${parts.join("  ")}`;
			});
			hint = `${this.selected + 1}/${count} · ↑↓ move · Enter open · Esc close`;
		} else {
			const item = this.open;
			const field = (name: string, value: string | undefined) => value ? [`${th.fg("dim", `${name}:`)} ${value}`] : [];
			const header = [
				`${this.arrow(item)} ${item.incoming ? "from" : "to"} ${this.who(item)}`,
				...field("Time", localTime(item.at, true)),
				...field("Id", item.id),
				...field("Mentions", item.mentions?.join(", ")),
				...field("Reply to", item.replyTo),
				...field("Urgent", item.urgent ? th.fg("warning", "yes") : undefined),
				...field("Status", this.status(item)),
				...field("Size", size(item.text)),
				"",
			];
			const lines = [...header, ...item.text.replace(/\t/g, "   ").split("\n")].flatMap((line) => {
				const wrapped = wrapTextWithAnsi(line, inner);
				return wrapped.length ? wrapped : [""];
			});
			this.maxScroll = Math.max(0, lines.length - height);
			this.scroll = Math.min(this.scroll, this.maxScroll);
			title = `${th.fg("accent", "✉ relay log")} ${th.fg("dim", `· message ${this.selected + 1} of ${this.items.length}`)}`;
			body = lines.slice(this.scroll, this.scroll + height);
			hint = `${this.maxScroll ? `lines ${this.scroll + 1}-${this.scroll + body.length} of ${lines.length} · ↑↓ scroll · ` : ""}Esc back`;
		}
		const lines = [rule("╭", "╮"), row(title), rule("├", "┤"), ...body.map(row), rule("├", "┤"), row(th.fg("dim", hint)), rule("╰", "╯")];
		return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
	}
}

export function overlayOptions(tui: Pick<TUI, "mode">): OverlayOptions {
	return tui.mode === "fullscreen"
		? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
		: { anchor: "center", width: "90%", maxHeight: "70%" };
}

/** Opens the log over the transcript until Esc or q closes it. */
export async function showRelayLog(context: ExtensionCommandContext, items: readonly LogItem[]): Promise<void> {
	let options = overlayOptions({ mode: "regular" });
	await context.ui.custom<undefined>((tui, theme, keybindings, done) => {
		options = overlayOptions(tui);
		return new RelayLog(tui, theme, keybindings, items, () => done(undefined));
	}, { overlay: true, overlayOptions: () => options });
}
