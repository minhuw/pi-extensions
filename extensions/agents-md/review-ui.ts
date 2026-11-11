import { diffWords, diffWordsWithSpace, structuredPatch } from "diff";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeybindingsManager,
	matchesKey,
	type OverlayOptions,
	replaceControlCharacters,
	stripTerminalSequences,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { LintFinding } from "./lint.ts";

export type ReviewChoice = "Apply" | "Reject" | "Reject with a note";

export interface ReviewInput {
	path: string;
	tool: "edit" | "write";
	before: string;
	after: string;
	existed: boolean;
	added: { findings: LintFinding[] } | { error: string };
}

export interface DiffStats {
	added: number;
	removed: number;
	hunks: number;
}

const DEFAULT_CONTEXT = 3;
const MAX_FINDINGS = 10;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const REVIEW_CHOICES: readonly ReviewChoice[] = ["Apply", "Reject", "Reject with a note"];
const HINTS = "←→/tab choose · enter confirm · a apply · r reject · n note · ↑↓/j k scroll · esc cancel";
/** Rows of chat context kept visible above the bottom-anchored overlay when the terminal is spacious. */
const TOP_CONTEXT_ROWS = 4;
const MIN_SPACIOUS_ROWS = 12;
const MIN_BODY_ROWS = 4;

/**
 * Full-width bottom-anchored overlay: renders above the dock (`status`, `widgetsAbove`, `footer`) so
 * tall widgets or large `AGENTS.md` diffs never shrink `editorContainer` and clip the bottom choices.
 */
export const REVIEW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "bottom-left",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
};

const lineText = (t: string): string => {
	const lf = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return lf === "" ? "" : lf.endsWith("\n") ? lf : `${lf}\n`;
};

function sanitizeText(text: string): string {
	return replaceControlCharacters(stripTerminalSequences(text.replace(/\t/g, "   ")));
}

function formatFinding(finding: LintFinding): string {
	return finding.line === undefined ? finding.message : `line ${finding.line}: ${finding.message}`;
}

export function diffStats(before: string, after: string, context = DEFAULT_CONTEXT): DiffStats {
	const oldStr = lineText(before);
	const newStr = lineText(after);
	if (oldStr === newStr) return { added: 0, removed: 0, hunks: 0 };
	const patch = structuredPatch("", "", oldStr, newStr, undefined, undefined, { context });
	let added = 0;
	let removed = 0;
	for (const hunk of patch.hunks) {
		for (const line of hunk.lines) {
			if (line === NO_NEWLINE_MARKER) continue;
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		}
	}
	return { added, removed, hunks: patch.hunks.length };
}

function applyInverse(theme: Theme, text: string): string {
	return typeof theme.inverse === "function" ? theme.inverse(text) : text;
}

function styleSegments(
	segments: readonly { text: string; changed: boolean }[],
	color: "toolDiffRemoved" | "toolDiffAdded",
	theme: Theme,
): string {
	let result = "";
	let buffer = "";
	let currentChanged: boolean | undefined;
	const flush = () => {
		if (!buffer) return;
		result += currentChanged ? theme.fg(color, applyInverse(theme, buffer)) : theme.fg(color, buffer);
		buffer = "";
	};
	for (const segment of segments) {
		if (!segment.text) continue;
		if (currentChanged !== undefined && currentChanged !== segment.changed) flush();
		currentChanged = segment.changed;
		buffer += segment.text;
	}
	flush();
	return result;
}

function pushChangedSegment(target: { text: string; changed: boolean }[], value: string): void {
	if (!value) return;
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
	if (!match || !match[2]) {
		target.push({ text: value, changed: true });
		return;
	}
	if (match[1]) target.push({ text: match[1], changed: false });
	target.push({ text: match[2], changed: true });
	if (match[3]) target.push({ text: match[3], changed: false });
}

function renderIntraLinePair(oldText: string, newText: string, theme: Theme): { removed: string; added: string } {
	const oldIndent = /^\s*/.exec(oldText)?.[0] ?? "";
	const newIndent = /^\s*/.exec(newText)?.[0] ?? "";
	const oldRest = oldText.slice(oldIndent.length);
	const newRest = newText.slice(newIndent.length);

	let parts = diffWords(oldRest, newRest);
	if (oldRest !== newRest && !parts.some((part) => part.added || part.removed)) {
		parts = diffWordsWithSpace(oldRest, newRest);
	}

	const removedSegments: { text: string; changed: boolean }[] = [];
	const addedSegments: { text: string; changed: boolean }[] = [];
	if (oldIndent) removedSegments.push({ text: oldIndent, changed: false });
	if (newIndent) addedSegments.push({ text: newIndent, changed: false });

	for (const part of parts) {
		if (part.removed) {
			pushChangedSegment(removedSegments, part.value);
		} else if (part.added) {
			pushChangedSegment(addedSegments, part.value);
		} else {
			removedSegments.push({ text: part.value, changed: false });
			addedSegments.push({ text: part.value, changed: false });
		}
	}

	return {
		removed: styleSegments(removedSegments, "toolDiffRemoved", theme),
		added: styleSegments(addedSegments, "toolDiffAdded", theme),
	};
}

function wrapDiffLine(
	styledContent: string,
	contentWidth: number,
	firstGutter: string,
	continuationGutter: string,
): string[] {
	const wrapped = styledContent ? wrapTextWithAnsi(styledContent, contentWidth) : [""];
	return wrapped.map((chunk, index) => {
		const closed =
			wrapped.length > 1 && index < wrapped.length - 1 && chunk.includes("\x1b[") ? `${chunk}\x1b[0m` : chunk;
		return `${index === 0 ? firstGutter : continuationGutter}${closed}`;
	});
}

export function renderReviewBody(
	input: ReviewInput,
	theme: Theme,
	width: number,
	context = DEFAULT_CONTEXT,
): string[] {
	const innerWidth = Math.max(1, width);
	const lines: string[] = [];

	const oldStr = lineText(input.before);
	const newStr = lineText(input.after);
	const patch =
		oldStr === newStr
			? undefined
			: structuredPatch(input.path, input.path, oldStr, newStr, undefined, undefined, { context });

	if (!patch || patch.hunks.length === 0) {
		lines.push(...wrapTextWithAnsi(theme.fg("muted", "(Only line endings or the final newline change.)"), innerWidth));
	} else {
		let maxLine = 1;
		for (const hunk of patch.hunks) {
			if (hunk.oldLines > 0) maxLine = Math.max(maxLine, hunk.oldStart + hunk.oldLines - 1);
			if (hunk.newLines > 0) maxLine = Math.max(maxLine, hunk.newStart + hunk.newLines - 1);
		}
		const numWidth = Math.max(1, String(maxLine).length);
		const blankNum = " ".repeat(numWidth);
		const blankNums = " ".repeat(numWidth * 2 + 1);
		const gutterCols = numWidth * 2 + 6;
		const contentWidth = Math.max(10, innerWidth - gutterCols);

		const contextContGutter = `${blankNums}${theme.fg("dim", " │ ")}  `;
		const removedContGutter = `${blankNums}${theme.fg("dim", " │ ")}${theme.fg("toolDiffRemoved", "  ")}`;
		const addedContGutter = `${blankNums}${theme.fg("dim", " │ ")}${theme.fg("toolDiffAdded", "  ")}`;

		patch.hunks.forEach((hunk, hunkIndex) => {
			if (hunkIndex > 0) lines.push("");
			const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
			const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
			const label = `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`;
			const trail = Math.max(0, innerWidth - 3 - label.length - 1);
			lines.push(
				theme.fg("dim", "── ") +
					theme.fg("muted", label) +
					(trail > 0 ? theme.fg("dim", ` ${"─".repeat(trail)}`) : ""),
			);

			let oldLine = hunk.oldStart;
			let newLine = hunk.newStart;
			const rawLines = hunk.lines.filter((line) => line !== NO_NEWLINE_MARKER);
			let i = 0;
			while (i < rawLines.length) {
				const raw = rawLines[i]!;
				if (raw.startsWith("-")) {
					const removedGroup: { oldLine: number; text: string }[] = [];
					while (i < rawLines.length && rawLines[i]!.startsWith("-")) {
						removedGroup.push({ oldLine: oldLine++, text: sanitizeText(rawLines[i]!.slice(1)) });
						i++;
					}
					const addedGroup: { newLine: number; text: string }[] = [];
					while (i < rawLines.length && rawLines[i]!.startsWith("+")) {
						addedGroup.push({ newLine: newLine++, text: sanitizeText(rawLines[i]!.slice(1)) });
						i++;
					}
					if (removedGroup.length === addedGroup.length) {
						const pairs = removedGroup.map((rem, k) => renderIntraLinePair(rem.text, addedGroup[k]!.text, theme));
						removedGroup.forEach((rem, k) => {
							const oldNum = String(rem.oldLine).padStart(numWidth, " ");
							const gutter = `${theme.fg("dim", `${oldNum} ${blankNum} │ `)}${theme.fg("toolDiffRemoved", "- ")}`;
							lines.push(...wrapDiffLine(pairs[k]!.removed, contentWidth, gutter, removedContGutter));
						});
						addedGroup.forEach((add, k) => {
							const newNum = String(add.newLine).padStart(numWidth, " ");
							const gutter = `${theme.fg("dim", `${blankNum} ${newNum} │ `)}${theme.fg("toolDiffAdded", "+ ")}`;
							lines.push(...wrapDiffLine(pairs[k]!.added, contentWidth, gutter, addedContGutter));
						});
					} else {
						for (const rem of removedGroup) {
							const oldNum = String(rem.oldLine).padStart(numWidth, " ");
							const gutter = `${theme.fg("dim", `${oldNum} ${blankNum} │ `)}${theme.fg("toolDiffRemoved", "- ")}`;
							const styled = rem.text ? theme.fg("toolDiffRemoved", rem.text) : "";
							lines.push(...wrapDiffLine(styled, contentWidth, gutter, removedContGutter));
						}
						for (const add of addedGroup) {
							const newNum = String(add.newLine).padStart(numWidth, " ");
							const gutter = `${theme.fg("dim", `${blankNum} ${newNum} │ `)}${theme.fg("toolDiffAdded", "+ ")}`;
							const styled = add.text ? theme.fg("toolDiffAdded", add.text) : "";
							lines.push(...wrapDiffLine(styled, contentWidth, gutter, addedContGutter));
						}
					}
				} else if (raw.startsWith("+")) {
					const newNum = String(newLine++).padStart(numWidth, " ");
					const text = sanitizeText(raw.slice(1));
					const gutter = `${theme.fg("dim", `${blankNum} ${newNum} │ `)}${theme.fg("toolDiffAdded", "+ ")}`;
					const styled = text ? theme.fg("toolDiffAdded", text) : "";
					lines.push(...wrapDiffLine(styled, contentWidth, gutter, addedContGutter));
					i++;
				} else {
					const oldNum = String(oldLine++).padStart(numWidth, " ");
					const newNum = String(newLine++).padStart(numWidth, " ");
					const text = sanitizeText(raw.startsWith(" ") ? raw.slice(1) : raw);
					const gutter = theme.fg("dim", `${oldNum} ${newNum} │   `);
					const styled = text ? theme.fg("toolDiffContext", text) : "";
					lines.push(...wrapDiffLine(styled, contentWidth, gutter, contextContGutter));
					i++;
				}
			}
		});
	}

	lines.push("");
	if ("error" in input.added) {
		lines.push(
			...wrapTextWithAnsi(theme.fg("error", `✗ Lint could not run: ${sanitizeText(input.added.error)}`), innerWidth),
		);
	} else if (input.added.findings.length === 0) {
		lines.push(
			...wrapTextWithAnsi(`${theme.fg("success", "✓")} ${theme.fg("muted", "No new lint findings.")}`, innerWidth),
		);
	} else {
		lines.push(
			...wrapTextWithAnsi(
				theme.fg("warning", `⚠ New lint findings (${input.added.findings.length}):`),
				innerWidth,
			),
		);
		const bulletWidth = Math.max(1, innerWidth - 2);
		for (const finding of input.added.findings.slice(0, MAX_FINDINGS)) {
			const styled = theme.fg("text", sanitizeText(formatFinding(finding)));
			const wrapped = wrapTextWithAnsi(styled, bulletWidth);
			wrapped.forEach((chunk, index) => {
				const closed =
					wrapped.length > 1 && index < wrapped.length - 1 && chunk.includes("\x1b[") ? `${chunk}\x1b[0m` : chunk;
				lines.push(`${index === 0 ? theme.fg("warning", "- ") : "  "}${closed}`);
			});
		}
		if (input.added.findings.length > MAX_FINDINGS) {
			lines.push(
				...wrapTextWithAnsi(
					theme.fg("muted", `- … and ${input.added.findings.length - MAX_FINDINGS} more`),
					innerWidth,
				),
			);
		}
	}

	return lines;
}

/**
 * Packs whole choices onto lines within `width`. When cramped vertically or narrower than an option,
 * falls back to a single row centered on the active choice so it is never truncated out of view.
 */
function renderChoiceRows(selectedIndex: number, width: number, maxChoiceRows: number, theme: Theme): string[] {
	const w = Math.max(1, width);
	const items = REVIEW_CHOICES.map((label, index) =>
		index === selectedIndex ? theme.fg("accent", theme.bold(`▸ ${label}`)) : theme.fg("text", `  ${label}`),
	);
	const packed: string[] = [];
	let current = "";
	let fitsEveryItem = true;
	for (const item of items) {
		const candidate = current ? `${current}    ${item}` : ` ${item}`;
		if (!current) {
			if (visibleWidth(candidate) > w) fitsEveryItem = false;
			current = candidate;
		} else if (visibleWidth(candidate) <= w) {
			current = candidate;
		} else {
			packed.push(truncateToWidth(current, w));
			if (visibleWidth(` ${item}`) > w) fitsEveryItem = false;
			current = ` ${item}`;
		}
	}
	if (current) packed.push(truncateToWidth(current, w));
	if (fitsEveryItem && packed.length <= maxChoiceRows) return packed;

	const active = REVIEW_CHOICES[selectedIndex]!;
	const compact = ` ${theme.fg("accent", theme.bold(`▸ ${active}`))} ${theme.fg("dim", `(${selectedIndex + 1}/${REVIEW_CHOICES.length} · ←→)`)}`;
	return [truncateToWidth(compact, w)];
}

export class ReviewDialog implements Component {
	readonly capturesViewportInput = true;
	private offset = 0;
	private selectedIndex = 0;
	private page = MIN_BODY_ROWS;
	private maxOffset: number | undefined;
	private readonly stats: DiffStats;
	private bodyCache: { width: number; lines: string[] } | undefined;
	private cache:
		| { width: number; rows: number; offset: number; selectedIndex: number; lines: string[] }
		| undefined;

	readonly input: ReviewInput;
	private readonly tui: { requestRender(): void; terminal: { rows: number } };
	private readonly theme: Theme;
	private readonly keybindings: Pick<KeybindingsManager, "matches"> | undefined;
	private readonly done: (choice: ReviewChoice | undefined) => void;

	constructor(
		input: ReviewInput,
		tui: { requestRender(): void; terminal: { rows: number } },
		theme: Theme,
		keybindings: Pick<KeybindingsManager, "matches"> | undefined,
		done: (choice: ReviewChoice | undefined) => void,
	) {
		this.input = input;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.stats = diffStats(input.before, input.after);
	}

	private moveOffset(delta: number): void {
		const base = this.maxOffset !== undefined ? Math.min(this.offset, this.maxOffset) : this.offset;
		const next = Math.max(0, base + delta);
		this.offset = this.maxOffset === undefined ? next : Math.min(next, this.maxOffset);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		const delta = event.wheelDelta ?? 0;
		if (delta !== 0) {
			const before = this.offset;
			this.moveOffset(delta);
			if (this.offset !== before) this.tui.requestRender();
		}
		return { handled: true };
	}

	handleInput(data: string): void {
		const { keybindings } = this;
		if (matchesKey(data, "a")) return this.done("Apply");
		if (matchesKey(data, "r")) return this.done("Reject");
		if (matchesKey(data, "n")) return this.done("Reject with a note");
		if (keybindings?.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			return this.done(undefined);
		}
		if (keybindings?.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter) || data === "\n") {
			return this.done(REVIEW_CHOICES[this.selectedIndex]!);
		}
		if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) {
			this.selectedIndex = (this.selectedIndex + 2) % REVIEW_CHOICES.length;
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.selectedIndex = (this.selectedIndex + 1) % REVIEW_CHOICES.length;
		} else if (keybindings?.matches(data, "tui.select.up") || matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.moveOffset(-1);
		} else if (keybindings?.matches(data, "tui.select.down") || matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.moveOffset(1);
		} else if (keybindings?.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
			this.moveOffset(-this.page);
		} else if (
			keybindings?.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.space)
		) {
			this.moveOffset(this.page);
		} else if (matchesKey(data, Key.home) || matchesKey(data, "g")) {
			this.offset = 0;
		} else if (matchesKey(data, Key.end) || matchesKey(data, "shift+g")) {
			this.offset = Number.MAX_SAFE_INTEGER;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.bodyCache = undefined;
		this.cache = undefined;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const innerWidth = Math.max(1, w - 1);
		const rawRows = this.tui.terminal?.rows;
		const rows = typeof rawRows === "number" && rawRows > 0 ? Math.floor(rawRows) : 24;
		const dialogBudget = rows > MIN_SPACIOUS_ROWS ? Math.max(MIN_SPACIOUS_ROWS, rows - TOP_CONTEXT_ROWS) : rows;
		const { theme, input, stats } = this;

		const action = !input.existed ? "creates" : input.tool === "write" ? "rewrites" : "edits";
		const counts =
			stats.added || stats.removed
				? `  ${theme.fg("toolDiffAdded", `+${stats.added}`)} ${theme.fg("toolDiffRemoved", `-${stats.removed}`)}`
				: "";
		const title = `${theme.fg("accent", theme.bold(`Review ${sanitizeText(input.path)}`))}${theme.fg("muted", ` · ${action}`)}${counts}`;
		const rule = theme.fg("borderMuted", "─".repeat(w));

		// Reserve the choice row(s) first so options stay pinned and visible at every terminal size.
		const maxChoiceRows = dialogBudget >= 6 ? REVIEW_CHOICES.length : 1;
		const choiceLines = renderChoiceRows(this.selectedIndex, w, maxChoiceRows, theme);
		if (dialogBudget <= choiceLines.length) {
			const minimal = choiceLines.slice(0, dialogBudget).map((line) => truncateToWidth(line, w));
			this.page = 1;
			this.maxOffset = 0;
			this.offset = 0;
			return minimal;
		}

		// Keep at least 1 row for the diff body; add title, hints, and rules only as remaining rows permit.
		let extraBudget = dialogBudget - choiceLines.length - 1;

		let titleLines: string[] = [];
		if (extraBudget >= 1) {
			const wrappedTitle = wrapTextWithAnsi(title, innerWidth).map((line) => ` ${line}`);
			titleLines = wrappedTitle.length <= extraBudget ? wrappedTitle : [truncateToWidth(` ${title}`, w)];
			extraBudget -= titleLines.length;
		}

		let hintLines: string[] = [];
		if (extraBudget >= 2) {
			const wrappedHints = wrapTextWithAnsi(theme.fg("dim", HINTS), innerWidth).map((line) => ` ${line}`);
			hintLines =
				extraBudget - wrappedHints.length >= 1
					? wrappedHints
					: [truncateToWidth(` ${theme.fg("dim", HINTS)}`, w)];
			extraBudget -= hintLines.length;
		}

		const showRules = extraBudget >= 2 + (dialogBudget >= MIN_SPACIOUS_ROWS ? MIN_BODY_ROWS - 1 : 1);
		const head = showRules ? [...titleLines, rule] : titleLines;
		const tail = showRules ? [rule, ...choiceLines, ...hintLines] : [...choiceLines, ...hintLines];

		let body = this.bodyCache?.width === innerWidth ? this.bodyCache.lines : undefined;
		if (!body) {
			body = renderReviewBody(input, theme, innerWidth).map((line) => (line ? ` ${line}` : ""));
			this.bodyCache = { width: innerWidth, lines: body };
		}

		const room = Math.max(1, dialogBudget - head.length - tail.length);
		const showOverflowStatus = body.length > room && room >= 2;
		const height = body.length <= room ? body.length : showOverflowStatus ? room - 1 : room;
		this.page = Math.max(1, height - 1);
		this.maxOffset = Math.max(0, body.length - height);
		this.offset = Math.min(Math.max(0, this.offset), this.maxOffset);

		const cached = this.cache;
		if (
			cached &&
			cached.width === width &&
			cached.rows === rows &&
			cached.offset === this.offset &&
			cached.selectedIndex === this.selectedIndex
		) {
			return cached.lines;
		}

		const lines = [...head, ...body.slice(this.offset, this.offset + height)];
		if (showOverflowStatus) {
			const last = this.offset + height;
			const more = last < body.length ? ` · ${body.length - last} more below` : " · end";
			lines.push(theme.fg("dim", ` lines ${this.offset + 1}-${last} of ${body.length}${more}`));
		}
		lines.push(...tail);
		const fitted = lines.map((line) => truncateToWidth(line, w));
		this.cache = { width, rows, offset: this.offset, selectedIndex: this.selectedIndex, lines: fitted };
		return fitted;
	}
}

export async function promptReviewDialog(
	ctx: Pick<ExtensionContext, "ui">,
	input: ReviewInput,
	signal?: AbortSignal,
): Promise<ReviewChoice | undefined> {
	if (signal?.aborted || typeof ctx.ui.custom !== "function") return undefined;
	let onAbort: (() => void) | undefined;
	try {
		const answer = await ctx.ui.custom<ReviewChoice | undefined>(
			(tui, theme, keybindings, done) => {
				onAbort = () => done(undefined);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				return new ReviewDialog(input, tui, theme, keybindings, done);
			},
			{
				overlay: true,
				overlayOptions: REVIEW_OVERLAY_OPTIONS,
				blocked: {
					kind: "permission",
					message: `Review ${sanitizeText(input.path)}`,
				},
			},
		);
		return signal?.aborted ? undefined : answer;
	} catch {
		return undefined;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
