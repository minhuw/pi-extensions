import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripBom } from "../artifacts/markdown.ts";

const TAB_REPLACEMENT = "    ";

const cleanLine = (text: string) => text.replace(/\r/g, "").replace(/\t/g, TAB_REPLACEMENT);
const padRight = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** Styles the summary, commit list, and diffstat in the delivery dialog without altering plain text. */
export function renderSummaryLines(summary: string, width: number, theme: Theme): string[] {
	const inner = Math.max(1, width - 1);
	const out: string[] = [];
	for (const raw of summary.replace(/\r\n/g, "\n").split("\n")) {
		const line = cleanLine(raw);
		if (!line) {
			out.push("");
			continue;
		}
		let styled: string;
		if (line === "Commits (oldest first):" || line === "Changes:") {
			styled = theme.fg("muted", theme.bold(line));
		} else {
			const statMatch = /^(.*\|\s*\d+\s+)([+-]+)$/.exec(line);
			if (statMatch) {
				const [, left, bars] = statMatch;
				const plus = bars!.match(/^\++/)?.[0] ?? "";
				const minus = bars!.slice(plus.length);
				styled = `${left}${plus ? theme.fg("toolDiffAdded", plus) : ""}${minus ? theme.fg("toolDiffRemoved", minus) : ""}`;
			} else if (/^\s+\d+\s+files?\s+changed\b/.test(line)) {
				styled = theme.fg("muted", line);
			} else {
				styled = line;
			}
		}
		for (const wrapped of wrapTextWithAnsi(styled, inner)) out.push(` ${wrapped}`);
	}
	return out;
}

const INLINE_MD = /(`+)([^`\n]+?)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const TABLE_SEP_ROW = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;
const FENCE_LINE = /^(\s*)(`{3,}|~{3,})(.*)$/;

function styleInlineMarkdown(text: string, theme: Theme, baseColor?: ThemeColor): string {
	let out = "";
	let last = 0;
	const paintBase = (chunk: string) => (chunk ? (baseColor ? theme.fg(baseColor, chunk) : chunk) : "");
	for (const match of text.matchAll(INLINE_MD)) {
		const at = match.index ?? 0;
		if (at > last) out += paintBase(text.slice(last, at));
		if (match[1] !== undefined) {
			out += theme.fg("mdCode", match[0]);
		} else if (match[3] !== undefined) {
			out += paintBase(theme.bold(match[3]));
		} else if (match[4] !== undefined && match[5] !== undefined) {
			out += `${theme.fg("mdLink", match[4])}${theme.fg("mdLinkUrl", ` (${match[5]})`)}`;
		}
		last = at + match[0].length;
	}
	if (last < text.length) out += paintBase(text.slice(last));
	return out;
}

function wrapHanging(prefix: string, body: string, width: number): string[] {
	const w = Math.max(1, width);
	const indent = visibleWidth(prefix);
	if (!body) return [truncateToWidth(prefix, w)];
	if (indent >= w / 2) return wrapTextWithAnsi(`${prefix}${body}`, w);
	const chunks = wrapTextWithAnsi(body, Math.max(1, w - indent));
	const pad = " ".repeat(indent);
	return (chunks.length ? chunks : [""]).map((chunk, idx) => `${idx === 0 ? prefix : pad}${chunk}`);
}

function splitTableCells(line: string): string[] {
	const cells: string[] = [];
	let cur = "";
	let inCode = false;
	const row = line.trim();
	for (let i = 0; i < row.length; i++) {
		const ch = row[i]!;
		if (ch === "`") {
			inCode = !inCode;
			cur += ch;
		} else if (ch === "\\" && row[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (ch === "|" && !inCode) {
			cells.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	cells.push(cur);
	if (row.startsWith("|")) cells.shift();
	if (row.endsWith("|") && !row.endsWith("\\|")) cells.pop();
	return cells.map((cell) => cleanLine(cell).trim());
}

function allocateColumnWidths(natural: readonly number[], budget: number): number[] {
	const widths = [...natural];
	let sum = widths.reduce((acc, n) => acc + n, 0);
	while (sum > budget) {
		let widest = -1;
		let maxVal = 1;
		for (let i = 0; i < widths.length; i++) {
			if (widths[i]! > maxVal) {
				maxVal = widths[i]!;
				widest = i;
			}
		}
		if (widest < 0) break;
		widths[widest]!--;
		sum--;
	}
	return widths;
}

function renderMarkdownTable(tableLines: readonly string[], innerWidth: number, theme: Theme): string[] {
	const headerCells = splitTableCells(tableLines[0]!);
	const bodyRows = tableLines.slice(2).map(splitTableCells);
	const colCount = Math.max(1, headerCells.length, ...bodyRows.map((r) => r.length));
	const borderOverhead = colCount * 3 + 1;

	// If the viewport is too narrow for column borders, wrap each row cleanly with styled pipes.
	if (innerWidth < borderOverhead + colCount) {
		const fallback: string[] = [];
		for (const [idx, raw] of tableLines.entries()) {
			if (idx === 1) continue;
			const styled = cleanLine(raw)
				.split("|")
				.map((part) => (idx === 0 ? theme.bold(styleInlineMarkdown(part, theme)) : styleInlineMarkdown(part, theme)))
				.join(theme.fg("borderMuted", "│"));
			fallback.push(...wrapTextWithAnsi(styled, innerWidth));
		}
		return fallback;
	}

	const styledHeader = Array.from({ length: colCount }, (_, c) => theme.bold(styleInlineMarkdown(headerCells[c] ?? "", theme)));
	const styledBody = bodyRows.map((row) => Array.from({ length: colCount }, (_, c) => styleInlineMarkdown(row[c] ?? "", theme)));
	const natural = Array.from({ length: colCount }, (_, c) => Math.max(1, visibleWidth(styledHeader[c]!), ...styledBody.map((row) => visibleWidth(row[c]!))));
	const colWidths = allocateColumnWidths(natural, innerWidth - borderOverhead);

	const vBar = theme.fg("borderMuted", "│");
	const sepLine = theme.fg("borderMuted", `├${colWidths.map((cw) => "─".repeat(cw + 2)).join("┼")}┤`);

	const formatRow = (cells: readonly string[]): string[] => {
		const wrappedCells = cells.map((cell, c) => {
			if (!cell) return [""];
			const wrapped = wrapTextWithAnsi(cell, Math.max(1, colWidths[c]!));
			return wrapped.length ? wrapped : [""];
		});
		const height = Math.max(1, ...wrappedCells.map((lines) => lines.length));
		const rows: string[] = [];
		for (let r = 0; r < height; r++) {
			const parts = wrappedCells.map((lines, c) => ` ${padRight(lines[r] ?? "", colWidths[c]!)} `);
			rows.push(`${vBar}${parts.join(vBar)}${vBar}`);
		}
		return rows;
	};

	const out = [...formatRow(styledHeader), sepLine];
	for (const row of styledBody) out.push(...formatRow(row));
	return out;
}

/** Renders `goal.md` with Markdown headings, code fences, inline code, tables, and list bullets styled for the TUI. */
export function renderGoalMarkdown(source: string, footerNote: string | undefined, width: number, theme: Theme): string[] {
	const w = Math.max(1, width);
	const inner = Math.max(1, w - 1);
	const rawLines = stripBom(source).replace(/\r\n/g, "\n").trim().split("\n");
	const out: string[] = [];

	let i = 0;
	let openFence: { char: string; len: number } | undefined;
	let inHtmlComment = false;

	while (i < rawLines.length) {
		const raw = cleanLine(rawLines[i]!);

		// Fenced code blocks (` ``` ` or `~~~`)
		const fenceMatch = FENCE_LINE.exec(raw);
		if (openFence) {
			const closes = fenceMatch && fenceMatch[2]![0] === openFence.char && fenceMatch[2]!.length >= openFence.len && !fenceMatch[3]!.trim();
			const color = closes ? "mdCodeBlockBorder" : "mdCodeBlock";
			if (!raw) out.push("");
			else for (const wrapped of wrapTextWithAnsi(theme.fg(color, raw), inner)) out.push(` ${wrapped}`);
			if (closes) openFence = undefined;
			i++;
			continue;
		}
		if (fenceMatch && !(fenceMatch[2]![0] === "`" && fenceMatch[3]!.includes("`"))) {
			openFence = { char: fenceMatch[2]![0]!, len: fenceMatch[2]!.length };
			for (const wrapped of wrapTextWithAnsi(theme.fg("mdCodeBlockBorder", raw), inner)) out.push(` ${wrapped}`);
			i++;
			continue;
		}

		// HTML comments (`<!-- ... -->`)
		if (inHtmlComment || raw.trimStart().startsWith("<!--")) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("dim", raw), inner)) out.push(` ${wrapped}`);
			inHtmlComment = !raw.includes("-->");
			i++;
			continue;
		}

		// Blank line
		if (!raw.trim()) {
			out.push("");
			i++;
			continue;
		}

		// GFM table block
		if (raw.includes("|") && i + 1 < rawLines.length && TABLE_SEP_ROW.test(rawLines[i + 1]!)) {
			const tableBlock = [rawLines[i]!, rawLines[i + 1]!];
			i += 2;
			while (i < rawLines.length && rawLines[i]!.includes("|") && rawLines[i]!.trim() !== "") {
				tableBlock.push(rawLines[i]!);
				i++;
			}
			for (const tableLine of renderMarkdownTable(tableBlock, inner, theme)) out.push(` ${tableLine}`);
			continue;
		}

		// Headings (`#`..`######`)
		if (/^#{1,6}\s+/.test(raw)) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("mdHeading", theme.bold(raw)), inner)) out.push(` ${wrapped}`);
			i++;
			continue;
		}

		// Horizontal rule
		if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(raw)) {
			out.push(` ${theme.fg("mdHr", "─".repeat(inner))}`);
			i++;
			continue;
		}

		// List bullets (`-`, `*`, `+`, `1.`)
		const listMatch = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(raw);
		if (listMatch) {
			const [, indent, bullet, space, rest] = listMatch;
			const prefix = `${indent}${theme.fg("mdListBullet", bullet!)}${space}`;
			const body = styleInlineMarkdown(rest!, theme);
			for (const wrapped of wrapHanging(prefix, body, inner)) out.push(` ${wrapped}`);
			i++;
			continue;
		}

		// Blockquotes (`> ...`)
		const quoteMatch = /^(\s*>\s?)(.*)$/.exec(raw);
		if (quoteMatch) {
			const [, prefix, rest] = quoteMatch;
			const styledPrefix = theme.fg("mdQuoteBorder", prefix!);
			const styledBody = styleInlineMarkdown(rest!, theme, "mdQuote");
			for (const wrapped of wrapHanging(styledPrefix, styledBody, inner)) out.push(` ${wrapped}`);
			i++;
			continue;
		}

		// Ordinary paragraph / budget line
		for (const wrapped of wrapTextWithAnsi(styleInlineMarkdown(raw, theme), inner)) out.push(` ${wrapped}`);
		i++;
	}

	if (footerNote) {
		out.push("");
		for (const wrapped of wrapTextWithAnsi(theme.fg("muted", cleanLine(footerNote)), inner)) out.push(` ${wrapped}`);
	}

	return out.map((line) => truncateToWidth(line, w));
}
