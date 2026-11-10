import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { diffWords, parsePatch, type StructuredPatchHunk } from "diff";
import { stripBom } from "../artifacts/markdown.ts";
import { DIFF_TRUNCATED_MARKER } from "../vcs/git.ts";

export const MAX_PATCH_CHARS = 200_000;
const MAX_INTRALINE_CHARS = 4_000;
const MAX_PAIR_RUN = 16;
const TAB_REPLACEMENT = "    ";

const cleanLine = (text: string) => text.replace(/\r/g, "").replace(/\t/g, TAB_REPLACEMENT);
const applyInverse = (theme: Theme, text: string) => (typeof theme.inverse === "function" ? theme.inverse(text) : text);
const padRight = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** Caps a unified diff string cleanly on a line boundary so huge patches stay instant. */
export function capPatch(rawPatch: string, maxChars = MAX_PATCH_CHARS): { patch: string; truncated: boolean } {
	let text = rawPatch.replace(/\r\n/g, "\n");
	let truncated = false;
	if (text.endsWith(DIFF_TRUNCATED_MARKER)) {
		text = text.slice(0, -DIFF_TRUNCATED_MARKER.length);
		truncated = true;
	}
	if (text.length > maxChars) {
		const slice = text.slice(0, maxChars);
		const nl = slice.lastIndexOf("\n");
		text = nl >= 0 ? slice.slice(0, nl) : slice;
		truncated = true;
	}
	return { patch: text, truncated };
}

/** Caps a unified diff and preserves a truncation marker for TUI rendering. */
export function capPatchText(rawPatch: string, maxChars = MAX_PATCH_CHARS): string {
	const { patch, truncated } = capPatch(rawPatch, maxChars);
	return truncated ? `${patch}${DIFF_TRUNCATED_MARKER}` : patch;
}

/** Styles the summary, commit list, and diffstat at the top of the delivery dialog without altering plain text. */
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

interface DiffSegment {
	text: string;
	changed: boolean;
}

interface ParsedHunk extends StructuredPatchHunk {
	header: string;
}

interface ParsedFileDiff {
	oldPath?: string;
	newPath?: string;
	isNew: boolean;
	isDeleted: boolean;
	isBinary: boolean;
	isRenamed: boolean;
	modeChange?: string;
	hunks: ParsedHunk[];
}

function unquoteGitPath(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/\\(["\\abfnrtv]|[0-7]{1,3})/g, (_, esc: string) => {
			if (esc === "n") return "\n";
			if (esc === "t") return "\t";
			if (esc === "r") return "\r";
			if (/^[0-7]+$/.test(esc)) return String.fromCharCode(Number.parseInt(esc, 8));
			return esc;
		});
	}
	return trimmed;
}

function cleanDiffPath(path: string | undefined): string | undefined {
	if (!path || path === "/dev/null") return undefined;
	const unquoted = unquoteGitPath(path);
	return unquoted.replace(/^[ab]\//, "");
}

function parseDiffGitLine(line: string): { oldPath?: string; newPath?: string } {
	const rest = line.slice("diff --git ".length).trim();
	if (rest.startsWith('"')) {
		const match = /^("(?:\\.|[^"])+")\s+("(?:\\.|[^"])+"|\S+)$/.exec(rest);
		if (match) return { oldPath: cleanDiffPath(match[1]), newPath: cleanDiffPath(match[2]) };
	}
	// Check exact `a/<p> b/<p>` midpoint first so paths containing spaces split unambiguously.
	if (rest.startsWith("a/") && rest.length % 2 === 1) {
		const mid = (rest.length - 1) / 2;
		if (rest[mid] === " " && rest.slice(mid + 1).startsWith("b/") && rest.slice(2, mid) === rest.slice(mid + 3)) {
			const same = rest.slice(2, mid);
			return { oldPath: same, newPath: same };
		}
	}
	const splitAt = rest.indexOf(" b/");
	if (splitAt > 0) {
		return { oldPath: cleanDiffPath(rest.slice(0, splitAt)), newPath: cleanDiffPath(rest.slice(splitAt + 1)) };
	}
	return {};
}

function splitPatchFiles(patch: string): string[] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let sawHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			if (current.length) chunks.push(current);
			current = [line];
			sawHunk = false;
			continue;
		}
		if (line.startsWith("--- ") && sawHunk) {
			chunks.push(current);
			current = [line];
			sawHunk = false;
			continue;
		}
		if (line.startsWith("@@ ")) sawHunk = true;
		if (current.length || line.trim()) current.push(line);
	}
	if (current.length) chunks.push(current);
	return chunks.map((lines) => lines.join("\n"));
}

/** Fallback hunk scanner used only when a huge patch was truncated mid-hunk so `parsePatch` rejects line counts. */
function scanTruncatedHunks(lines: readonly string[]): ParsedHunk[] {
	const hunks: ParsedHunk[] = [];
	let current: ParsedHunk | undefined;
	for (const line of lines) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
		if (header) {
			const oldLines = header[2] === undefined ? 1 : Number(header[2]);
			const newLines = header[4] === undefined ? 1 : Number(header[4]);
			current = {
				oldStart: Number(header[1]) + (oldLines === 0 ? 1 : 0),
				oldLines,
				newStart: Number(header[3]) + (newLines === 0 ? 1 : 0),
				newLines,
				lines: [],
				header: line,
			};
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")) {
			current.lines.push(line);
		}
	}
	return hunks;
}

function parseFileSection(section: string): ParsedFileDiff | undefined {
	const rawLines = section.split("\n");
	let oldPath: string | undefined;
	let newPath: string | undefined;
	let isNew = false;
	let isDeleted = false;
	let isBinary = false;
	let isRenamed = false;
	let oldMode: string | undefined;
	let newMode: string | undefined;
	const rawHeaders: string[] = [];

	for (const line of rawLines) {
		if (line.startsWith("@@ ")) {
			rawHeaders.push(line);
			continue;
		}
		if (rawHeaders.length > 0) continue;
		if (line.startsWith("diff --git ")) {
			const parsed = parseDiffGitLine(line);
			oldPath = parsed.oldPath;
			newPath = parsed.newPath;
		} else if (line.startsWith("new file mode ")) isNew = true;
		else if (line.startsWith("deleted file mode ")) isDeleted = true;
		else if (line.startsWith("old mode ")) oldMode = line.slice("old mode ".length).trim();
		else if (line.startsWith("new mode ")) newMode = line.slice("new mode ".length).trim();
		else if (line.startsWith("rename from ")) {
			oldPath = unquoteGitPath(line.slice("rename from ".length));
			isRenamed = true;
		} else if (line.startsWith("rename to ")) {
			newPath = unquoteGitPath(line.slice("rename to ".length));
			isRenamed = true;
		} else if ((line.startsWith("Binary files ") && line.endsWith(" differ")) || line === "GIT binary patch") {
			isBinary = true;
		} else if (line.startsWith("--- ")) {
			const headerPath = line.slice(4).split("\t", 1)[0]?.trim();
			if (headerPath === "/dev/null") isNew = true;
			else if (headerPath) oldPath = cleanDiffPath(headerPath) ?? oldPath;
		} else if (line.startsWith("+++ ")) {
			const headerPath = line.slice(4).split("\t", 1)[0]?.trim();
			if (headerPath === "/dev/null") isDeleted = true;
			else if (headerPath) newPath = cleanDiffPath(headerPath) ?? newPath;
		}
	}

	let hunks: ParsedHunk[] = [];
	if (rawHeaders.length > 0) {
		try {
			const [structured] = parsePatch(section);
			if (structured) {
				if (structured.oldFileName === "/dev/null") isNew = true;
				else if (structured.oldFileName) oldPath = cleanDiffPath(structured.oldFileName) ?? oldPath;
				if (structured.newFileName === "/dev/null") isDeleted = true;
				else if (structured.newFileName) newPath = cleanDiffPath(structured.newFileName) ?? newPath;
				hunks = structured.hunks.map((hunk, idx) => ({
					...hunk,
					header: rawHeaders[idx] ?? `@@ -${hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldLines} +${hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newLines} @@`,
				}));
			}
		} catch {
			hunks = scanTruncatedHunks(rawLines);
		}
	}

	if (!isNew && !isDeleted && oldPath && newPath && oldPath !== newPath) isRenamed = true;
	if (!oldPath && !newPath && hunks.length === 0 && !isBinary) return undefined;
	const modeChange = !isNew && !isDeleted && oldMode && newMode && oldMode !== newMode ? `${oldMode} → ${newMode}` : undefined;
	return { oldPath, newPath, isNew, isDeleted, isBinary, isRenamed, modeChange, hunks };
}

function computeIntraLineDiff(oldText: string, newText: string): { removed: DiffSegment[]; added: DiffSegment[]; commonChars: number } {
	if (oldText.length + newText.length > MAX_INTRALINE_CHARS) {
		return {
			removed: [{ text: oldText, changed: false }],
			added: [{ text: newText, changed: false }],
			commonChars: 0,
		};
	}
	const parts = diffWords(oldText, newText);
	const removed: DiffSegment[] = [];
	const added: DiffSegment[] = [];
	let seenRemovedNonWs = false;
	let seenAddedNonWs = false;
	let commonChars = 0;

	for (const part of parts) {
		if (part.removed) {
			let val = part.value;
			if (!seenRemovedNonWs) {
				const leading = /^\s*/.exec(val)?.[0] ?? "";
				if (leading) {
					removed.push({ text: leading, changed: false });
					val = val.slice(leading.length);
				}
				if (val) seenRemovedNonWs = true;
			}
			if (val) removed.push({ text: val, changed: true });
		} else if (part.added) {
			let val = part.value;
			if (!seenAddedNonWs) {
				const leading = /^\s*/.exec(val)?.[0] ?? "";
				if (leading) {
					added.push({ text: leading, changed: false });
					val = val.slice(leading.length);
				}
				if (val) seenAddedNonWs = true;
			}
			if (val) added.push({ text: val, changed: true });
		} else {
			const nonWs = part.value.replace(/\s+/g, "").length;
			if (nonWs > 0) {
				seenRemovedNonWs = true;
				seenAddedNonWs = true;
				commonChars += nonWs;
			}
			removed.push({ text: part.value, changed: false });
			added.push({ text: part.value, changed: false });
		}
	}
	return { removed, added, commonChars };
}

function pairChangeBlock(removedLines: readonly string[], addedLines: readonly string[]): {
	removedSegments: DiffSegment[][];
	addedSegments: DiffSegment[][];
} {
	const removedSegments = removedLines.map((text): DiffSegment[] => [{ text, changed: false }]);
	const addedSegments = addedLines.map((text): DiffSegment[] => [{ text, changed: false }]);
	const rLen = removedLines.length;
	const aLen = addedLines.length;
	if (!rLen || !aLen || rLen > MAX_PAIR_RUN || aLen > MAX_PAIR_RUN) return { removedSegments, addedSegments };

	if (rLen === 1 && aLen === 1) {
		const diff = computeIntraLineDiff(removedLines[0]!, addedLines[0]!);
		removedSegments[0] = diff.removed;
		addedSegments[0] = diff.added;
		return { removedSegments, addedSegments };
	}

	if (rLen === aLen) {
		for (let k = 0; k < rLen; k++) {
			const diff = computeIntraLineDiff(removedLines[k]!, addedLines[k]!);
			if (diff.commonChars > 0) {
				removedSegments[k] = diff.removed;
				addedSegments[k] = diff.added;
			}
		}
		return { removedSegments, addedSegments };
	}

	// Greedy monotonic pairing for asymmetric N-to-M edits (e.g. 1 modified line + 1 added line).
	let minAddedIdx = 0;
	for (let i = 0; i < rLen && minAddedIdx < aLen; i++) {
		const oldNonWs = removedLines[i]!.replace(/\s+/g, "").length;
		if (!oldNonWs) continue;
		let bestIdx = -1;
		let bestScore = 0;
		let bestDiff: ReturnType<typeof computeIntraLineDiff> | undefined;
		for (let j = minAddedIdx; j < aLen; j++) {
			const newNonWs = addedLines[j]!.replace(/\s+/g, "").length;
			if (!newNonWs) continue;
			const diff = computeIntraLineDiff(removedLines[i]!, addedLines[j]!);
			const score = (2 * diff.commonChars) / (oldNonWs + newNonWs);
			if (score >= 0.35 && score > bestScore) {
				bestScore = score;
				bestIdx = j;
				bestDiff = diff;
			}
		}
		if (bestIdx >= 0 && bestDiff) {
			removedSegments[i] = bestDiff.removed;
			addedSegments[bestIdx] = bestDiff.added;
			minAddedIdx = bestIdx + 1;
		}
	}
	return { removedSegments, addedSegments };
}

function styleDiffSegments(segments: readonly DiffSegment[], color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", theme: Theme): string {
	let out = "";
	let buf = "";
	let bufChanged: boolean | undefined;
	const flush = () => {
		if (!buf) return;
		out += bufChanged ? theme.fg(color, applyInverse(theme, buf)) : theme.fg(color, buf);
		buf = "";
	};
	for (const seg of segments) {
		if (!seg.text) continue;
		if (bufChanged !== undefined && bufChanged !== seg.changed) flush();
		bufChanged = seg.changed;
		buf += seg.text;
	}
	flush();
	return out;
}

function wrapDiffRow(
	gutterFirst: string,
	gutterCont: string,
	gutterWidth: number,
	marker: "+" | "-" | " ",
	color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext",
	segments: readonly DiffSegment[],
	width: number,
	theme: Theme,
): string[] {
	const styledMarker = theme.fg(color, marker);
	const styledContent = styleDiffSegments(segments, color, theme);
	if (width < gutterWidth + 4) {
		return wrapTextWithAnsi(`${gutterFirst}${styledMarker}${styledContent}`, Math.max(1, width)).map((line) => truncateToWidth(line, width));
	}
	const contentWidth = Math.max(1, width - gutterWidth - 1);
	if (!styledContent) return [truncateToWidth(`${gutterFirst}${styledMarker}`, width)];
	const chunks = wrapTextWithAnsi(styledContent, contentWidth);
	if (!chunks.length) return [truncateToWidth(`${gutterFirst}${styledMarker}`, width)];
	return chunks.map((chunk, idx) => truncateToWidth(idx === 0 ? `${gutterFirst}${styledMarker}${chunk}` : `${gutterCont} ${chunk}`, width));
}

function renderFileHeader(file: ParsedFileDiff, added: number, removed: number, width: number, theme: Theme): string[] {
	const w = Math.max(1, width);
	const displayPath = file.isRenamed && file.oldPath && file.newPath && file.oldPath !== file.newPath
		? `${file.oldPath} → ${file.newPath}`
		: (file.isDeleted ? file.oldPath : file.newPath ?? file.oldPath) ?? "unknown";

	const tags: string[] = [];
	if (file.isNew) tags.push("new");
	if (file.isDeleted) tags.push("deleted");
	if (file.isBinary) tags.push("binary");
	else if (file.isRenamed && file.hunks.length === 0) tags.push("renamed");
	if (file.modeChange) tags.push(`mode ${file.modeChange}`);
	const tagText = tags.length ? theme.fg("muted", ` (${tags.join(", ")})`) : "";

	const showCounts = !file.isBinary && (file.hunks.length > 0 || file.isNew || file.isDeleted);
	const statsText = showCounts ? `  ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}` : "";

	const lead = ` ${theme.fg("muted", "──")} ${theme.fg("accent", theme.bold(cleanLine(displayPath)))}${tagText}${statsText} `;
	const leadWidth = visibleWidth(lead);
	if (leadWidth + 2 <= w) {
		return [`${lead}${theme.fg("borderMuted", "─".repeat(w - leadWidth))}`];
	}
	return wrapTextWithAnsi(lead.trimEnd(), Math.max(1, w - 1)).map((line) => truncateToWidth(line.startsWith(" ") ? line : ` ${line}`, w));
}

/** Renders a unified git patch with per-file headers, dual line-number gutters, intra-line word diffs, and aligned wrapping. */
export function renderUnifiedDiff(rawPatch: string, width: number, theme: Theme, maxChars = MAX_PATCH_CHARS): string[] {
	const w = Math.max(1, width);
	const { patch, truncated } = capPatch(rawPatch, maxChars);
	if (!patch.trim()) return [];

	const sections = splitPatchFiles(patch);
	const out: string[] = [];

	for (const section of sections) {
		const file = parseFileSection(section);
		if (!file) continue;
		if (out.length > 0) out.push("");

		let addedCount = 0;
		let removedCount = 0;
		let maxOld = 1;
		let maxNew = 1;
		for (const hunk of file.hunks) {
			maxOld = Math.max(maxOld, hunk.oldStart + Math.max(0, hunk.oldLines - 1));
			maxNew = Math.max(maxNew, hunk.newStart + Math.max(0, hunk.newLines - 1));
			for (const line of hunk.lines) {
				if (line.startsWith("+")) addedCount++;
				else if (line.startsWith("-")) removedCount++;
			}
		}

		out.push(...renderFileHeader(file, addedCount, removedCount, w, theme));

		const colWidth = Math.max(2, String(Math.max(maxOld, maxNew)).length);
		const blankNum = " ".repeat(colWidth);
		const gutterWidth = 1 + colWidth + 1 + colWidth + 3; // ` <old> <new> │ `
		const gutterCont = theme.fg("dim", ` ${blankNum} ${blankNum} │ `);

		for (const hunk of file.hunks) {
			const headerClean = cleanLine(hunk.header);
			const headerMatch = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/.exec(headerClean);
			const styledHunkHeader = headerMatch
				? `${theme.fg("muted", headerMatch[1]!)}${headerMatch[2] ? theme.fg("dim", headerMatch[2]) : ""}`
				: theme.fg("muted", headerClean);
			for (const wrapped of wrapTextWithAnsi(styledHunkHeader, Math.max(1, w - 1))) {
				out.push(truncateToWidth(` ${wrapped}`, w));
			}

			let oldLine = hunk.oldStart;
			let newLine = hunk.newStart;
			const lines = hunk.lines;
			let idx = 0;

			while (idx < lines.length) {
				const raw = lines[idx]!;
				const op = raw[0];

				if (op === "-" || op === "+") {
					const removedRun: Array<{ num: number; text: string }> = [];
					const removedNotes: string[] = [];
					while (idx < lines.length && (lines[idx]!.startsWith("-") || lines[idx]!.startsWith("\\"))) {
						const cur = lines[idx]!;
						if (cur.startsWith("-")) removedRun.push({ num: oldLine++, text: cleanLine(cur.slice(1)) });
						else removedNotes.push(cleanLine(cur));
						idx++;
					}

					const addedRun: Array<{ num: number; text: string }> = [];
					const addedNotes: string[] = [];
					while (idx < lines.length && (lines[idx]!.startsWith("+") || lines[idx]!.startsWith("\\"))) {
						const cur = lines[idx]!;
						if (cur.startsWith("+")) addedRun.push({ num: newLine++, text: cleanLine(cur.slice(1)) });
						else addedNotes.push(cleanLine(cur));
						idx++;
					}

					const { removedSegments, addedSegments } = pairChangeBlock(
						removedRun.map((item) => item.text),
						addedRun.map((item) => item.text),
					);

					for (let r = 0; r < removedRun.length; r++) {
						const gutter = theme.fg("dim", ` ${String(removedRun[r]!.num).padStart(colWidth)} ${blankNum} │ `);
						out.push(...wrapDiffRow(gutter, gutterCont, gutterWidth, "-", "toolDiffRemoved", removedSegments[r]!, w, theme));
					}
					for (const note of removedNotes) {
						out.push(...wrapTextWithAnsi(`${gutterCont}${theme.fg("dim", ` ${note}`)}`, w).map((line) => truncateToWidth(line, w)));
					}
					for (let a = 0; a < addedRun.length; a++) {
						const gutter = theme.fg("dim", ` ${blankNum} ${String(addedRun[a]!.num).padStart(colWidth)} │ `);
						out.push(...wrapDiffRow(gutter, gutterCont, gutterWidth, "+", "toolDiffAdded", addedSegments[a]!, w, theme));
					}
					for (const note of addedNotes) {
						out.push(...wrapTextWithAnsi(`${gutterCont}${theme.fg("dim", ` ${note}`)}`, w).map((line) => truncateToWidth(line, w)));
					}
					continue;
				}

				if (op === "\\") {
					out.push(...wrapTextWithAnsi(`${gutterCont}${theme.fg("dim", ` ${cleanLine(raw)}`)}`, w).map((line) => truncateToWidth(line, w)));
					idx++;
					continue;
				}

				// Context line (` ` or empty)
				const content = cleanLine(raw.length > 0 ? raw.slice(1) : "");
				const gutter = theme.fg("dim", ` ${String(oldLine++).padStart(colWidth)} ${String(newLine++).padStart(colWidth)} │ `);
				out.push(...wrapDiffRow(gutter, gutterCont, gutterWidth, " ", "toolDiffContext", [{ text: content, changed: false }], w, theme));
				idx++;
			}
		}
	}

	if (truncated) {
		if (out.length > 0) out.push("");
		const notice = `… diff preview truncated at ${maxChars.toLocaleString("en-US")} characters; full file stats are shown above.`;
		for (const wrapped of wrapTextWithAnsi(theme.fg("muted", notice), Math.max(1, w - 1))) {
			out.push(truncateToWidth(` ${wrapped}`, w));
		}
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
