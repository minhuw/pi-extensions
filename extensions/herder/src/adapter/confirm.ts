import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, type KeyId, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderGoalMarkdown, renderSummaryLines } from "./preview.ts";

const HINTS = "↑↓/j k scroll · pgup/pgdn page · home/end · ←→/tab choose · y yes · n no · enter confirm · esc close without answering";
const GOAL_HINTS = "↑↓/j k scroll · pgup/pgdn page · g/G top/end · ←→/tab choose · y/a approve · n/r reject · e reject with note · enter confirm · esc close";
/** Lines kept free for Pi's chat tail, footer, and widgets around the dialog. */
const RESERVED_ROWS = 6;
const MIN_BODY_ROWS = 3;

/** A deliberate yes or no, or undefined when the dialog closed without an answer (Esc or an abort). */
export type Answer = boolean | undefined;

export type GoalChoice = "approve" | "reject" | "reject_note";
type GoalReviewOutcome = { choice: "approve" | "reject"; note?: string } | undefined;

type DialogChoice<T> = {
	readonly id: T;
	readonly label: string;
	readonly keys: readonly KeyId[];
};

const CONFIRM_CHOICES: readonly DialogChoice<boolean>[] = [
	{ id: true, label: "Yes", keys: ["y"] },
	{ id: false, label: "No", keys: ["n"] },
];

const GOAL_CHOICES: readonly DialogChoice<GoalChoice>[] = [
	{ id: "approve", label: "Approve", keys: ["y", "a"] },
	{ id: "reject", label: "Reject", keys: ["n", "r"] },
	{ id: "reject_note", label: "Reject with a note", keys: ["e"] },
];

type DialogTui = { requestRender(): void; terminal: { rows: number } };
type DialogKeys = Pick<KeybindingsManager, "matches">;

function applyScrollKey(data: string, keybindings: DialogKeys, offset: number, page: number): number | undefined {
	if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) return offset - 1;
	if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) return offset + 1;
	if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) return offset - page;
	if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) return offset + page;
	if (matchesKey(data, Key.home) || matchesKey(data, "g")) return 0;
	if (matchesKey(data, Key.end) || matchesKey(data, "shift+g")) return Number.MAX_SAFE_INTEGER;
	return undefined;
}

function renderOptionsRow(items: readonly string[], width: number): string[] {
	const w = Math.max(1, width);
	const lines: string[] = [];
	let current = "";
	for (const item of items) {
		const candidate = current ? `${current}    ${item}` : ` ${item}`;
		if (!current || visibleWidth(candidate) <= w) {
			current = candidate;
		} else {
			lines.push(truncateToWidth(current, w));
			current = ` ${item}`;
		}
	}
	if (current) lines.push(truncateToWidth(current, w));
	return lines;
}

function renderBoundedDialog(
	width: number,
	rows: number,
	theme: Theme,
	title: string,
	body: readonly string[],
	options: readonly string[],
	hints: string,
	offset: number,
): { lines: string[]; offset: number; page: number } {
	const w = Math.max(1, width);
	const rule = theme.fg("borderMuted", "─".repeat(w));
	const head = [...wrapTextWithAnsi(theme.fg("accent", theme.bold(title)), Math.max(1, w - 1)).map((line) => ` ${line}`), rule];
	const tail = [rule, ...renderOptionsRow(options, w), ...wrapTextWithAnsi(theme.fg("dim", hints), Math.max(1, w - 1)).map((line) => ` ${line}`)];
	// The status line under the body takes a row only when the body overflows.
	const room = Math.max(MIN_BODY_ROWS, rows - RESERVED_ROWS - head.length - tail.length);
	const height = body.length <= room ? body.length : Math.max(1, room - 1);
	const page = Math.max(1, height - 1);
	const clamped = Math.min(Math.max(0, offset), Math.max(0, body.length - height));
	const lines = [...head, ...body.slice(clamped, clamped + height)];
	if (body.length > height) {
		const last = clamped + height;
		const more = last < body.length ? ` · ${body.length - last} more below` : " · end";
		lines.push(theme.fg("dim", ` lines ${clamped + 1}-${last} of ${body.length}${more}`));
	}
	lines.push(...tail);
	return { lines: lines.map((line) => truncateToWidth(line, w)), offset: clamped, page };
}

type DialogConfig<T> = {
	readonly title: string;
	readonly choices: readonly DialogChoice<T>[];
	readonly hints: string;
	readonly formatBody: (width: number, theme: Theme) => string[];
	readonly tui: DialogTui;
	readonly theme: Theme;
	readonly keybindings: DialogKeys;
	readonly done: (value: T | undefined) => void;
};

class ScrollableChoiceDialog<T> implements Component {
	private readonly title: string;
	private readonly choices: readonly DialogChoice<T>[];
	private readonly hints: string;
	private readonly formatBody: (width: number, theme: Theme) => string[];
	private readonly tui: DialogTui;
	private readonly theme: Theme;
	private readonly keybindings: DialogKeys;
	private readonly done: (value: T | undefined) => void;
	private offset = 0;
	private choice = 0;
	/** The body height of the last render; paging moves by it. */
	private page = MIN_BODY_ROWS;
	private bodyCache: { width: number; lines: string[] } | undefined;
	private cache: { width: number; rows: number; offset: number; choice: number; lines: string[] } | undefined;

	constructor(config: DialogConfig<T>) {
		this.title = config.title;
		this.choices = config.choices;
		this.hints = config.hints;
		this.formatBody = config.formatBody;
		this.tui = config.tui;
		this.theme = config.theme;
		this.keybindings = config.keybindings;
		this.done = config.done;
	}

	handleInput(data: string): void {
		const { keybindings } = this;
		for (const choice of this.choices) {
			if (choice.keys.some((key) => matchesKey(data, key))) return this.done(choice.id);
		}
		if (keybindings.matches(data, "tui.select.cancel")) return this.done(undefined);
		if (keybindings.matches(data, "tui.select.confirm")) return this.done(this.choices[this.choice]!.id);
		const scrolled = applyScrollKey(data, keybindings, this.offset, this.page);
		if (scrolled !== undefined) this.offset = scrolled;
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.choice = (this.choice + 1) % this.choices.length;
		else if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) this.choice = (this.choice - 1 + this.choices.length) % this.choices.length;
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.bodyCache = undefined;
		this.cache = undefined;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const rows = this.tui.terminal.rows;
		const cached = this.cache;
		if (cached && cached.width === width && cached.rows === rows && cached.offset === this.offset && cached.choice === this.choice) {
			return cached.lines;
		}
		const { theme } = this;
		if (!this.bodyCache || this.bodyCache.width !== w) {
			this.bodyCache = { width: w, lines: this.formatBody(w, theme) };
		}
		const options = this.choices.map((entry, idx) =>
			idx === this.choice ? theme.fg("accent", `▸ ${entry.label}`) : theme.fg("text", `  ${entry.label}`),
		);
		const rendered = renderBoundedDialog(w, rows, theme, this.title, this.bodyCache.lines, options, this.hints, this.offset);
		this.page = rendered.page;
		this.offset = rendered.offset;
		this.cache = { width, rows, offset: this.offset, choice: this.choice, lines: rendered.lines };
		return rendered.lines;
	}
}

/**
 * A Yes/No confirmation whose body scrolls inside a bounded viewport, so the choice stays on screen
 * however long the body is. Pi's `ctx.ui.confirm` renders the whole body above the options.
 */
export class ScrollableConfirm implements Component {
	readonly title: string;
	readonly body: string;
	private readonly dialog: ScrollableChoiceDialog<boolean>;

	constructor(
		title: string,
		body: string,
		tui: DialogTui,
		theme: Theme,
		keybindings: DialogKeys,
		done: (answer: Answer) => void,
		formatBody?: (body: string, width: number, theme: Theme) => string[],
	) {
		this.title = title;
		this.body = body;
		this.dialog = new ScrollableChoiceDialog({
			title,
			choices: CONFIRM_CHOICES,
			hints: HINTS,
			formatBody: (width, currentTheme) =>
				formatBody
					? formatBody(body, width, currentTheme)
					: wrapTextWithAnsi(body, Math.max(1, width - 1)).map((line) => ` ${line}`),
			tui,
			theme,
			keybindings,
			done,
		});
	}

	handleInput(data: string): void {
		this.dialog.handleInput(data);
	}

	invalidate(): void {
		this.dialog.invalidate();
	}

	render(width: number): string[] {
		return this.dialog.render(width);
	}
}

/**
 * Goal approval dialog with styled `goal.md` Markdown in a scrollable viewport and three pinned choices:
 * `Approve`, `Reject`, and `Reject with a note`.
 */
export class GoalReviewDialog implements Component {
	readonly title: string;
	readonly goalMarkdown: string;
	readonly footerNote: string | undefined;
	private readonly dialog: ScrollableChoiceDialog<GoalChoice>;

	constructor(
		title: string,
		goalMarkdown: string,
		footerNote: string | undefined,
		tui: DialogTui,
		theme: Theme,
		keybindings: DialogKeys,
		done: (choice: GoalChoice | undefined) => void,
	) {
		this.title = title;
		this.goalMarkdown = goalMarkdown;
		this.footerNote = footerNote;
		this.dialog = new ScrollableChoiceDialog({
			title,
			choices: GOAL_CHOICES,
			hints: GOAL_HINTS,
			formatBody: (width, currentTheme) => renderGoalMarkdown(goalMarkdown, footerNote, width, currentTheme),
			tui,
			theme,
			keybindings,
			done,
		});
	}

	handleInput(data: string): void {
		this.dialog.handleInput(data);
	}

	invalidate(): void {
		this.dialog.invalidate();
	}

	render(width: number): string[] {
		return this.dialog.render(width);
	}
}

async function runCustomDialog<T>(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	build: (tui: DialogTui, theme: Theme, keybindings: DialogKeys, done: (value: T | undefined) => void) => Component,
): Promise<T | undefined> {
	if (signal?.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	const value = await ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
		onAbort = () => done(undefined);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return build(tui, theme, keybindings, done);
	}).finally(() => {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	});
	return signal?.aborted ? undefined : value;
}

/**
 * `ctx.ui.confirm`, with a scrollable body in the TUI so long bodies cannot push the choice off screen.
 * Only the TUI tells a dismissal (undefined) from a deliberate no; `ctx.ui.confirm` reports both as false.
 */
export async function confirmLong(ctx: ExtensionContext, title: string, body: string, signal?: AbortSignal): Promise<Answer> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return ctx.ui.confirm(title, body, { signal });
	return runCustomDialog<boolean>(ctx, signal, (tui, theme, keybindings, done) => new ScrollableConfirm(title, body, tui, theme, keybindings, done));
}

/**
 * Confirms delivery: uses `ctx.ui.confirm` outside TUI, and `ScrollableConfirm` with styled summary + diffstat in TUI.
 */
export async function confirmDelivery(ctx: ExtensionContext, title: string, summary: string, signal?: AbortSignal): Promise<Answer> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return ctx.ui.confirm(title, summary, { signal });
	return runCustomDialog<boolean>(
		ctx,
		signal,
		(tui, theme, keybindings, done) => new ScrollableConfirm(title, summary, tui, theme, keybindings, done, renderSummaryLines),
	);
}

/**
 * Reviews `goal.md`: uses `ctx.ui.confirm` outside TUI for RPC compatibility, and `GoalReviewDialog` in TUI with
 * styled Markdown and `Approve` / `Reject` / `Reject with a note`.
 */
export async function reviewGoal(
	ctx: ExtensionContext,
	title: string,
	goalMarkdown: string,
	footerNote = "The goal is frozen once approved.",
	signal?: AbortSignal,
): Promise<GoalReviewOutcome> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
		const body = footerNote ? `${goalMarkdown.trim()}\n\n${footerNote}` : goalMarkdown.trim();
		const confirmed = await ctx.ui.confirm(title, body, { signal });
		return { choice: confirmed ? "approve" : "reject" };
	}
	const picked = await runCustomDialog<GoalChoice>(
		ctx,
		signal,
		(tui, theme, keybindings, done) => new GoalReviewDialog(title, goalMarkdown, footerNote, tui, theme, keybindings, done),
	);
	if (picked === undefined) return undefined;
	if (picked === "approve") return { choice: "approve" };
	if (picked === "reject") return { choice: "reject" };
	const rawNote = typeof ctx.ui.input === "function"
		? await ctx.ui.input("What should change in goal.md?", "a note for the agent", { signal })
		: undefined;
	if (signal?.aborted) return undefined;
	const note = rawNote?.trim();
	return note ? { choice: "reject", note } : { choice: "reject" };
}
