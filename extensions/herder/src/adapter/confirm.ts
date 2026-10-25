import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const HINTS = "↑↓/j k scroll · pgup/pgdn page · home/end · ←→/tab choose · y yes · n no · enter confirm · esc close without answering";
/** Lines kept free for Pi's chat tail, footer, and widgets around the dialog. */
const RESERVED_ROWS = 6;
const MIN_BODY_ROWS = 3;

/** A deliberate yes or no, or undefined when the dialog closed without an answer (Esc or an abort). */
export type Answer = boolean | undefined;

/**
 * A Yes/No confirmation whose body scrolls inside a bounded viewport, so the choice stays on screen
 * however long the body is. Pi's `ctx.ui.confirm` renders the whole body above the options.
 */
export class ScrollableConfirm implements Component {
	private offset = 0;
	private yes = true;
	private cache: { width: number; rows: number; offset: number; yes: boolean; lines: string[] } | undefined;
	/** The body height of the last render; paging moves by it. */
	private page = MIN_BODY_ROWS;

	constructor(
		readonly title: string,
		readonly body: string,
		private readonly tui: { requestRender(): void; terminal: { rows: number } },
		private readonly theme: Theme,
		private readonly keybindings: Pick<KeybindingsManager, "matches">,
		private readonly done: (answer: Answer) => void,
	) {}

	handleInput(data: string): void {
		const { keybindings } = this;
		if (matchesKey(data, "y")) return this.done(true);
		if (matchesKey(data, "n")) return this.done(false);
		if (keybindings.matches(data, "tui.select.cancel")) return this.done(undefined);
		if (keybindings.matches(data, "tui.select.confirm")) return this.done(this.yes);
		if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) this.offset -= 1;
		else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) this.offset += 1;
		else if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) this.offset -= this.page;
		else if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) this.offset += this.page;
		else if (matchesKey(data, Key.home) || matchesKey(data, "g")) this.offset = 0;
		else if (matchesKey(data, Key.end) || matchesKey(data, "shift+g")) this.offset = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) this.yes = !this.yes;
		else return;
		this.tui.requestRender();
	}

	invalidate(): void { this.cache = undefined; }

	render(width: number): string[] {
		const w = Math.max(1, width);
		const rows = this.tui.terminal.rows;
		const { theme } = this;
		const rule = theme.fg("borderMuted", "─".repeat(w));
		const head = [...wrapTextWithAnsi(theme.fg("accent", theme.bold(this.title)), Math.max(1, w - 1)).map((line) => ` ${line}`), rule];
		const option = (label: string, chosen: boolean) => chosen ? theme.fg("accent", `▸ ${label}`) : theme.fg("text", `  ${label}`);
		const tail = [rule, ` ${option("Yes", this.yes)}    ${option("No", !this.yes)}`, ...wrapTextWithAnsi(theme.fg("dim", HINTS), Math.max(1, w - 1)).map((line) => ` ${line}`)];
		const body = wrapTextWithAnsi(this.body, Math.max(1, w - 1)).map((line) => ` ${line}`);
		// The status line under the body takes a row only when the body overflows.
		const room = Math.max(MIN_BODY_ROWS, rows - RESERVED_ROWS - head.length - tail.length);
		const height = body.length <= room ? body.length : Math.max(1, room - 1);
		this.page = Math.max(1, height - 1);
		this.offset = Math.min(Math.max(0, this.offset), body.length - height);
		const cached = this.cache;
		if (cached && cached.width === width && cached.rows === rows && cached.offset === this.offset && cached.yes === this.yes) return cached.lines;
		const lines = [...head, ...body.slice(this.offset, this.offset + height)];
		if (body.length > height) {
			const last = this.offset + height;
			const more = last < body.length ? ` · ${body.length - last} more below` : " · end";
			lines.push(theme.fg("dim", ` lines ${this.offset + 1}-${last} of ${body.length}${more}`));
		}
		lines.push(...tail);
		const fitted = lines.map((line) => truncateToWidth(line, w));
		this.cache = { width, rows, offset: this.offset, yes: this.yes, lines: fitted };
		return fitted;
	}
}

/**
 * `ctx.ui.confirm`, with a scrollable body in the TUI so long bodies cannot push the choice off screen.
 * Only the TUI tells a dismissal (undefined) from a deliberate no; `ctx.ui.confirm` reports both as false.
 */
export async function confirmLong(ctx: ExtensionContext, title: string, body: string, signal?: AbortSignal): Promise<Answer> {
	if (ctx.mode !== "tui") return ctx.ui.confirm(title, body, { signal });
	if (signal?.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	const answer = await ctx.ui.custom<Answer>((tui, theme, keybindings, done) => {
		onAbort = () => done(undefined);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return new ScrollableConfirm(title, body, tui, theme, keybindings, done);
	}).finally(() => { if (onAbort) signal?.removeEventListener("abort", onAbort); });
	return signal?.aborted ? undefined : answer;
}
