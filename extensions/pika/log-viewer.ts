/**
 * A log of the current branch over the transcript: a list with one row per item, the newest selected, that opens
 * each item in full. `/relay log` and `/memory log` show theirs in it. Every string is shown as the caller gives it,
 * so the caller strips terminal sequences and control characters from whatever came from elsewhere.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, matchesKey, type OverlayOptions, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** "42 chars" below 1000, "1.2k chars" below 10 000, then "12k chars". */
export function size(text: string): string {
	const count = [...text].length;
	if (count < 1000) return `${count} char${count === 1 ? "" : "s"}`;
	const thousands = count / 1000;
	return `${thousands < 9.95 ? Math.round(thousands * 10) / 10 : Math.round(thousands)}k chars`;
}

const two = (value: number) => String(value).padStart(2, "0");
/** The local "HH:MM" of an ISO time, or with `seconds` its full local date and time. */
export function localTime(at: string, seconds = false): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return seconds ? "unknown time" : "--:--";
	const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
	return seconds ? `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${clock}:${two(date.getSeconds())}` : clock;
}

/** One item of a log, styled with the viewer's theme. */
export interface LogViewItem {
	/** When it happened; its row shows the local HH:MM. */
	at: string;
	/** A mark before the time, such as relay's ← and →. */
	icon?: string;
	/** The row's parts after the time, two spaces apart; empty ones are left out. */
	parts: string[];
	/** The first line of the item opened. */
	heading: string;
	/** `Name: value` lines under the heading; fields without a value are left out. */
	fields: [name: string, value: string | undefined][];
	/** The full text under the fields, wrapped to the width and scrolled. */
	text: string;
}

export interface LogView {
	/** Such as "✉ relay log". */
	title: string;
	/** What one item is called, and several, such as ["message", "messages"]. */
	noun: [one: string, many: string];
	/** Oldest first. */
	items: readonly LogViewItem[];
}

const CHROME = 6;

export class LogViewer implements Component {
	private selected: number;
	private top = 0;
	private open: LogViewItem | undefined;
	private scroll = 0;
	private maxScroll = 0;

	constructor(
		private readonly tui: Pick<TUI, "mode" | "requestRender"> & { terminal: { rows: number } },
		private readonly theme: Theme,
		private readonly keys: Pick<KeybindingsManager, "matches"> | undefined,
		private readonly log: LogView,
		private readonly done: () => void,
	) {
		this.selected = Math.max(0, log.items.length - 1);
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
			this.open = this.log.items[this.selected];
			this.scroll = 0;
		} else if (is("tui.select.up", "up")) move = -1;
		else if (is("tui.select.down", "down")) move = 1;
		else if (is("tui.select.pageUp", "pageUp")) move = -this.height();
		else if (is("tui.select.pageDown", "pageDown")) move = this.height();
		else if (matchesKey(data, "home")) move = -Infinity;
		else if (matchesKey(data, "end")) move = Infinity;
		else return;
		if (this.open) this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + move));
		else this.selected = Math.max(0, Math.min(this.log.items.length - 1, this.selected + move));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const { items, noun: [one, many] } = this.log;
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
			this.top = Math.max(0, Math.min(this.top, items.length - height));
			const count = items.length;
			title = `${th.fg("accent", this.log.title)} ${th.fg("dim", `· ${count} ${count === 1 ? one : many} on this branch`)}`;
			body = items.slice(this.top, this.top + height).map((item, index) => {
				const mark = this.top + index === this.selected ? th.fg("accent", "▸") : " ";
				return `${mark} ${item.icon ? `${item.icon} ` : ""}${th.fg("dim", localTime(item.at))}  ${item.parts.filter(Boolean).join("  ")}`;
			});
			hint = `${this.selected + 1}/${count} · ↑↓ move · Enter open · Esc close`;
		} else {
			const item = this.open;
			const header = [item.heading, ...item.fields.flatMap(([name, value]) => value ? [`${th.fg("dim", `${name}:`)} ${value}`] : []), ""];
			const lines = [...header, ...item.text.replace(/\t/g, "   ").split("\n")].flatMap((line) => {
				const wrapped = wrapTextWithAnsi(line, inner);
				return wrapped.length ? wrapped : [""];
			});
			this.maxScroll = Math.max(0, lines.length - height);
			this.scroll = Math.min(this.scroll, this.maxScroll);
			title = `${th.fg("accent", this.log.title)} ${th.fg("dim", `· ${one} ${this.selected + 1} of ${items.length}`)}`;
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

/** Opens the log `view` builds with the TUI's theme over the transcript, until Esc or q closes it. */
export async function showLog(context: ExtensionCommandContext, view: (theme: Theme) => LogView): Promise<void> {
	let options = overlayOptions({ mode: "regular" });
	await context.ui.custom<undefined>((tui, theme, keybindings, done) => {
		options = overlayOptions(tui);
		return new LogViewer(tui, theme, keybindings, view(theme), () => done(undefined));
	}, { overlay: true, overlayOptions: () => options });
}
