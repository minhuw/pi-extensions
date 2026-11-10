import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	Key,
	type Keybinding,
	matchesKey,
	replaceControlCharacters,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface QuestionChoice {
	id: string;
	label: string;
	description?: string;
}

export interface QuestionItem {
	id: string;
	question: string;
	description?: string;
	choices?: readonly QuestionChoice[];
	allowFreeText?: boolean;
}

export interface TuiQuestionAnswer {
	value: string;
	choiceId?: string;
}

export interface QuestionTui {
	terminal?: { rows?: number; columns?: number };
	requestRender(force?: boolean): void;
}

export interface KeybindingsLike {
	matches(data: string, keybinding: Keybinding): boolean;
}

interface ChoiceOptionItem {
	readonly labelPart: string;
	readonly description: string | undefined;
	readonly rawLabel: string;
	readonly choiceId: string | undefined;
	readonly isCustom: boolean;
}

/** Strip terminal escape sequences first, then replace remaining C0/C1 control characters with spaces. */
export function sanitizeInlineText(text: string): string {
	return replaceControlCharacters(stripTerminalSequences(text));
}

/** Strip terminal escape sequences while preserving line breaks across paragraphs. */
export function sanitizeMultilineText(text: string): string[] {
	const stripped = stripTerminalSequences(text).replace(/\r\n?/g, "\n");
	return stripped.split("\n").map((line) => replaceControlCharacters(line.replace(/\t/g, "  ")));
}

function wrapStyledParagraphs(lines: readonly string[], width: number, style: (line: string) => string): string[] {
	const w = Math.max(1, width);
	const out: string[] = [];
	for (const line of lines) {
		if (line.length === 0) {
			out.push("");
			continue;
		}
		for (const wrapped of wrapTextWithAnsi(line, w)) {
			out.push(style(wrapped));
		}
	}
	return out;
}

function buildChoiceItems(question: QuestionItem): ChoiceOptionItem[] {
	const choices = question.choices;
	if (!choices || choices.length === 0) return [];
	const counts = new Map<string, number>();
	for (const choice of choices) {
		counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
	}
	const rawLabels = choices.map(
		(choice) =>
			`${choice.label}${(counts.get(choice.label) ?? 0) > 1 ? ` (${choice.id})` : ""}${choice.description ? ` — ${choice.description}` : ""}`,
	);
	const items: ChoiceOptionItem[] = choices.map((choice) => {
		const cleanLabel = sanitizeInlineText(choice.label);
		const cleanId = sanitizeInlineText(choice.id);
		const duplicated = (counts.get(choice.label) ?? 0) > 1;
		return {
			labelPart: duplicated ? `${cleanLabel} (${cleanId})` : cleanLabel,
			description: choice.description ? sanitizeInlineText(choice.description) : undefined,
			rawLabel: choice.label,
			choiceId: choice.id,
			isCustom: false,
		};
	});
	if (question.allowFreeText) {
		let custom = "Other: type your own answer";
		while (rawLabels.includes(custom) || items.some((item) => item.labelPart === custom && !item.description)) {
			custom += " (free text)";
		}
		items.push({
			labelPart: custom,
			description: undefined,
			rawLabel: custom,
			choiceId: undefined,
			isCustom: true,
		});
	}
	return items;
}

function renderChoiceItem(item: ChoiceOptionItem, selected: boolean, innerWidth: number, theme: Theme): string[] {
	const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
	const body = selected
		? `${theme.fg("accent", theme.bold(item.labelPart))}${item.description ? theme.fg("muted", ` — ${item.description}`) : ""}`
		: `${theme.fg("text", item.labelPart)}${item.description ? theme.fg("dim", ` — ${item.description}`) : ""}`;
	if (innerWidth <= 4) {
		return [` ${truncateToWidth(prefix + body, Math.max(1, innerWidth))}`];
	}
	const wrapped = wrapTextWithAnsi(body, innerWidth - 2);
	if (wrapped.length === 0) return [` ${prefix}`];
	return wrapped.map((line, index) => (index === 0 ? ` ${prefix}${line}` : `   ${line}`));
}

export class QuestionDialog implements Component, Focusable {
	readonly capturesViewportInput = true;
	private readonly question: QuestionItem;
	private readonly questionIndex: number;
	private readonly totalQuestions: number;
	private readonly tui: QuestionTui;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsLike | undefined;
	private readonly done: (result: TuiQuestionAnswer | undefined) => void;
	private readonly items: ChoiceOptionItem[];
	private readonly input: Input;
	private mode: "choice" | "input";
	private openedFromCustomChoice = false;
	private selectedIndex = 0;
	private choiceOffset = 0;
	private scrollOffset = 0;
	private scrollPage = 5;
	private maxScrollOffset: number | undefined;
	private pasteActive = false;
	private _focused = false;
	private upperCache: { innerWidth: number; lines: string[] } | undefined;

	constructor(
		question: QuestionItem,
		questionIndex: number,
		totalQuestions: number,
		tui: QuestionTui,
		theme: Theme,
		keybindings: KeybindingsLike | undefined,
		done: (result: TuiQuestionAnswer | undefined) => void,
	) {
		this.question = question;
		this.questionIndex = questionIndex;
		this.totalQuestions = totalQuestions;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.items = buildChoiceItems(question);
		this.mode = this.items.length > 0 ? "choice" : "input";
		this.input = new Input({
			prompt: theme.fg("accent", "▸ "),
			placeholder: "Your answer",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		this.input.onSubmit = (value) => this.done({ value });
		this.input.onEscape = () => this.done(undefined);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode === "input";
	}

	private moveScroll(delta: number): void {
		const next = Math.max(0, this.scrollOffset + delta);
		this.scrollOffset = this.maxScrollOffset === undefined ? next : Math.min(next, this.maxScrollOffset);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && (this.maxScrollOffset ?? 0) > 0) {
			this.moveScroll(event.wheelDelta && event.wheelDelta < 0 ? -3 : 3);
			return { handled: true, render: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		const kb = this.keybindings ?? getKeybindings();
		if (this.mode === "input") {
			this.handleFreeTextInput(data, kb);
			return;
		}
		this.handleChoiceInput(data, kb);
	}

	private handleChoiceInput(data: string, kb: KeybindingsLike): void {
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter) || data === "\n") {
			const selected = this.items[this.selectedIndex];
			if (!selected) {
				this.done(undefined);
				return;
			}
			if (selected.isCustom) {
				this.mode = "input";
				this.openedFromCustomChoice = true;
				this.input.focused = this._focused;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.done({ value: selected.rawLabel, choiceId: selected.choiceId });
			return;
		}
		if (
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.editor.pageUp") ||
			matchesKey(data, Key.pageUp)
		) {
			this.moveScroll(-this.scrollPage);
			this.tui.requestRender();
			return;
		}
		if (
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.editor.pageDown") ||
			matchesKey(data, Key.pageDown)
		) {
			this.moveScroll(this.scrollPage);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("up")) || matchesKey(data, Key.ctrlShift("up"))) {
			this.moveScroll(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("down")) || matchesKey(data, Key.ctrlShift("down"))) {
			this.moveScroll(1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.up") || matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down") || matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
		}
	}

	private handleFreeTextInput(data: string, kb: KeybindingsLike): void {
		if (data.includes("\x1b[200~")) {
			this.pasteActive = true;
		}
		if (this.pasteActive) {
			const lastStart = data.lastIndexOf("\x1b[200~");
			const lastEnd = data.lastIndexOf("\x1b[201~");
			if (lastEnd !== -1 && lastEnd > lastStart) {
				this.pasteActive = false;
			}
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (
			kb.matches(data, "tui.input.submit") ||
			kb.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter) ||
			data === "\n"
		) {
			this.done({ value: this.input.getValue() });
			return;
		}
		if (
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.editor.pageUp") ||
			matchesKey(data, Key.pageUp)
		) {
			this.moveScroll(-this.scrollPage);
			this.tui.requestRender();
			return;
		}
		if (
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.editor.pageDown") ||
			matchesKey(data, Key.pageDown)
		) {
			this.moveScroll(this.scrollPage);
			this.tui.requestRender();
			return;
		}
		if (
			matchesKey(data, Key.ctrl("up")) ||
			matchesKey(data, Key.ctrlShift("up")) ||
			matchesKey(data, Key.up) ||
			kb.matches(data, "tui.editor.cursorUp")
		) {
			this.moveScroll(-1);
			this.tui.requestRender();
			return;
		}
		if (
			matchesKey(data, Key.ctrl("down")) ||
			matchesKey(data, Key.ctrlShift("down")) ||
			matchesKey(data, Key.down) ||
			kb.matches(data, "tui.editor.cursorDown")
		) {
			this.moveScroll(1);
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.upperCache = undefined;
		this.input.invalidate();
	}

	private getUpperLines(innerWidth: number): string[] {
		if (this.upperCache?.innerWidth === innerWidth) return this.upperCache.lines;
		const { theme, question } = this;
		const questionLines = wrapStyledParagraphs(sanitizeMultilineText(question.question), innerWidth, (line) =>
			theme.fg("accent", theme.bold(line)),
		).map((line) => (line ? ` ${line}` : ""));
		const descriptionLines = question.description
			? wrapStyledParagraphs(sanitizeMultilineText(question.description), innerWidth, (line) =>
					theme.fg("text", line),
				).map((line) => (line ? ` ${line}` : ""))
			: [];
		const combined = descriptionLines.length > 0 ? [...questionLines, "", ...descriptionLines] : questionLines;
		const lines = combined.length > 0 ? combined : [""];
		this.upperCache = { innerWidth, lines };
		return lines;
	}

	private renderChoices(innerWidth: number, budget: number): string[] {
		const { theme, items } = this;
		const rendered = items.map((item, idx) => renderChoiceItem(item, idx === this.selectedIndex, innerWidth, theme));
		const totalRows = rendered.reduce((sum, rows) => sum + rows.length, 0);
		if (totalRows <= budget) {
			this.choiceOffset = 0;
			return rendered.flat();
		}
		const showStatus = budget >= 3;
		const listBudget = showStatus ? budget - 1 : budget;
		this.choiceOffset = Math.min(Math.max(0, this.choiceOffset), this.selectedIndex);
		const rowsBetween = (from: number, toInclusive: number): number => {
			let sum = 0;
			for (let i = from; i <= toInclusive; i++) sum += rendered[i]!.length;
			return sum;
		};
		while (this.choiceOffset < this.selectedIndex && rowsBetween(this.choiceOffset, this.selectedIndex) > listBudget) {
			this.choiceOffset++;
		}
		let start = this.choiceOffset;
		let end = start;
		let visibleRows: string[];
		const firstItemRows = rendered[start]!;
		if (start === this.selectedIndex && firstItemRows.length > listBudget) {
			visibleRows =
				listBudget >= 2
					? [...firstItemRows.slice(0, listBudget - 1), `${firstItemRows[listBudget - 1]!} ${theme.fg("dim", "…")}`]
					: [firstItemRows[0]!];
		} else {
			let used = firstItemRows.length;
			while (end + 1 < rendered.length && used + rendered[end + 1]!.length <= listBudget) {
				end++;
				used += rendered[end]!.length;
			}
			while (start > 0 && used + rendered[start - 1]!.length <= listBudget) {
				start--;
				used += rendered[start]!.length;
			}
			this.choiceOffset = start;
			visibleRows = rendered.slice(start, end + 1).flat();
		}
		if (showStatus) {
			visibleRows.push(theme.fg("dim", `   choices ${start + 1}-${end + 1} of ${rendered.length}`));
		}
		return visibleRows;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const innerWidth = Math.max(1, w - 2);
		const termRows = this.tui.terminal?.rows && this.tui.terminal.rows > 0 ? this.tui.terminal.rows : 24;
		const maxRows = Math.max(1, termRows);
		const { theme } = this;

		const progressParts: string[] = [];
		if (this.totalQuestions > 1) {
			progressParts.push(`Question ${this.questionIndex + 1} of ${this.totalQuestions}`);
		}
		if (this.mode === "input" && this.openedFromCustomChoice) {
			progressParts.push("Custom answer");
		}
		const progressLine = progressParts.length > 0 ? ` ${theme.fg("muted", progressParts.join(" · "))}` : undefined;

		const showBorders = maxRows >= 8;
		const showProgress = Boolean(progressLine) && maxRows >= 5;
		const showHints = maxRows >= 6;
		const showSpacer = maxRows >= 9;
		const chromeRows =
			(showBorders ? 2 : 0) + (showProgress ? 1 : 0) + (showHints ? 1 : 0) + (showSpacer ? 1 : 0);
		const contentBudget = Math.max(2, maxRows - chromeRows);

		const upperLines = this.getUpperLines(innerWidth);
		let upperBudget: number;
		let lowerLines: string[];

		if (this.mode === "input") {
			lowerLines = this.input.render(innerWidth).map((line) => ` ${line}`);
			upperBudget = Math.max(1, contentBudget - lowerLines.length);
		} else {
			const allChoiceRows = this.items.reduce(
				(sum, item, idx) => sum + renderChoiceItem(item, idx === this.selectedIndex, innerWidth, theme).length,
				0,
			);
			let lowerBudget: number;
			if (upperLines.length + allChoiceRows <= contentBudget) {
				upperBudget = upperLines.length;
				lowerBudget = allChoiceRows;
			} else if (allChoiceRows <= Math.max(3, Math.floor(contentBudget * 0.5))) {
				lowerBudget = allChoiceRows;
				upperBudget = Math.max(1, contentBudget - lowerBudget);
			} else if (upperLines.length <= Math.max(2, Math.floor(contentBudget * 0.4))) {
				upperBudget = upperLines.length;
				lowerBudget = Math.max(1, contentBudget - upperBudget);
			} else {
				upperBudget = Math.max(2, Math.floor(contentBudget * 0.5));
				lowerBudget = Math.max(1, contentBudget - upperBudget);
			}
			lowerLines = this.renderChoices(innerWidth, lowerBudget);
		}

		const upperOverflows = upperLines.length > upperBudget;
		let renderedUpper: string[];
		if (!upperOverflows) {
			this.scrollPage = Math.max(1, upperLines.length - 1);
			this.maxScrollOffset = 0;
			this.scrollOffset = 0;
			renderedUpper = upperLines;
		} else {
			const showScrollStatus = upperBudget >= 2;
			const visibleHeight = showScrollStatus ? upperBudget - 1 : upperBudget;
			this.scrollPage = Math.max(1, visibleHeight - 1);
			this.maxScrollOffset = Math.max(0, upperLines.length - visibleHeight);
			this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), this.maxScrollOffset);
			const slice = upperLines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);
			if (showScrollStatus) {
				const first = this.scrollOffset + 1;
				const last = this.scrollOffset + slice.length;
				const more = last < upperLines.length ? ` · ${upperLines.length - last} more below` : " · end";
				renderedUpper = [...slice, theme.fg("dim", ` lines ${first}-${last} of ${upperLines.length}${more}`)];
			} else {
				renderedUpper = slice;
			}
		}

		const rule = theme.fg("borderMuted", "─".repeat(w));
		const lines: string[] = [];
		if (showBorders) lines.push(rule);
		if (showProgress && progressLine) lines.push(progressLine);
		lines.push(...renderedUpper);
		if (showSpacer) lines.push("");
		lines.push(...lowerLines);
		if (showHints) {
			const hints =
				this.mode === "choice"
					? upperOverflows
						? "↑↓ select · PgUp/PgDn scroll · enter confirm · esc cancel"
						: "↑↓ select · enter confirm · esc cancel"
					: upperOverflows
						? "PgUp/PgDn scroll · enter submit · esc cancel"
						: "enter submit · esc cancel";
			lines.push(` ${theme.fg("dim", hints)}`);
		}
		if (showBorders) lines.push(rule);

		return lines.slice(0, maxRows).map((line) => truncateToWidth(line, w));
	}
}

export async function promptTuiQuestion(
	ui: Pick<ExtensionUIContext, "custom">,
	question: QuestionItem,
	options: { index: number; total: number; signal?: AbortSignal },
): Promise<TuiQuestionAnswer | undefined> {
	const { signal } = options;
	if (signal?.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	try {
		const answer = await ui.custom<TuiQuestionAnswer | undefined>(
			(tui, theme, keybindings, done) => {
				let settled = false;
				const finish = (result: TuiQuestionAnswer | undefined) => {
					if (settled) return;
					settled = true;
					done(result);
				};
				onAbort = () => finish(undefined);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				return new QuestionDialog(question, options.index, options.total, tui, theme, keybindings, finish);
			},
			{
				blocked: {
					kind: "question",
					message: sanitizeInlineText(question.question),
				},
			},
		);
		return signal?.aborted ? undefined : answer;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
