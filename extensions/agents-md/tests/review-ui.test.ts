// Rich TUI diff review UI for agents-md: diff statistics, ANSI diff + word-level highlight + wrapped gutter rendering,
// interactive ReviewDialog navigation/scrolling, and the TUI custom-dialog path in reviewToolCall.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, Theme, ThemeBg, ThemeColor, ThemeStyle } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	KeybindingsManager,
	ScrollView,
	stripTerminalSequences,
	type Terminal,
	Text,
	TuiAltScreen,
	TUI_KEYBINDINGS,
	visibleWidth,
	VStack,
} from "@earendil-works/pi-tui";
import { CHOICES, reasons, reviewToolCall, STANDING_APPROVAL_KEY } from "../gate.ts";
import {
	diffStats,
	promptReviewDialog,
	renderReviewBody,
	REVIEW_OVERLAY_OPTIONS,
	ReviewDialog,
	type ReviewChoice,
	type ReviewInput,
} from "../review-ui.ts";

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	tab: "\t",
	shiftTab: "\x1b[Z",
	enter: "\r",
	esc: "\x1b",
	space: " ",
} as const;

/**
 * Distinct, deterministic SGR sequences per token so `visibleWidth`, `wrapTextWithAnsi`, and `truncateToWidth`
 * treat all styling as zero-width ANSI while assertions can still inspect exact semantic tokens.
 */
const FG_ANSI: Record<string, string> = {
	toolDiffAdded: "\x1b[32m",
	toolDiffRemoved: "\x1b[31m",
	toolDiffContext: "\x1b[38;5;245m",
	accent: "\x1b[36m",
	warning: "\x1b[33m",
	error: "\x1b[91m",
	success: "\x1b[92m",
	muted: "\x1b[38;5;244m",
	dim: "\x1b[90m",
	border: "\x1b[38;5;241m",
	borderAccent: "\x1b[38;5;242m",
	borderMuted: "\x1b[38;5;240m",
	text: "\x1b[38;5;252m",
};

const BG_ANSI: Record<string, string> = {
	selectedBg: "\x1b[48;5;236m",
	toolPendingBg: "\x1b[48;5;235m",
	toolSuccessBg: "\x1b[48;5;22m",
	toolErrorBg: "\x1b[48;5;52m",
};

function createFakeTheme(): Theme {
	const getFgAnsi = (color: ThemeColor) => FG_ANSI[color] ?? "\x1b[38;5;250m";
	const getBgAnsi = (color: ThemeBg) => BG_ANSI[color] ?? "\x1b[48;5;237m";
	const fg = (color: ThemeColor, text: string) => `${getFgAnsi(color)}${text}\x1b[39m`;
	const bg = (color: ThemeBg, text: string) => `${getBgAnsi(color)}${text}\x1b[49m`;
	const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const italic = (text: string) => `\x1b[3m${text}\x1b[23m`;
	const underline = (text: string) => `\x1b[4m${text}\x1b[24m`;
	const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`;
	const strikethrough = (text: string) => `\x1b[9m${text}\x1b[29m`;
	const style = (text: string, options: ThemeStyle) => {
		let out = text;
		if (options.inverse) out = inverse(out);
		if (options.bold) out = bold(out);
		if (options.dim) out = `\x1b[2m${out}\x1b[22m`;
		if (options.italic) out = italic(out);
		if (options.underline) out = underline(out);
		if (options.strikethrough) out = strikethrough(out);
		if (typeof options.fg === "string") out = fg(options.fg, out);
		if (typeof options.bg === "string") out = bg(options.bg, out);
		return out;
	};
	return {
		appearance: "dark",
		fg,
		bg,
		bold,
		italic,
		underline,
		inverse,
		strikethrough,
		style,
		getFgAnsi,
		getBgAnsi,
		getColorMode: () => "256color",
	} as unknown as Theme;
}

const theme = createFakeTheme();
const defaultKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);

/** Walks SGR state across a rendered line and returns contiguous visible substrings rendered with SGR 7 (`inverse`). */
function invertedRuns(line: string): string[] {
	const runs: string[] = [];
	let current = "";
	let inverse = false;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			const end = line.indexOf("m", i + 2);
			if (end !== -1) {
				const raw = line.slice(i + 2, end);
				const codes = raw === "" ? [0] : raw.split(";").map((part) => Number.parseInt(part, 10));
				for (let idx = 0; idx < codes.length; idx++) {
					const code = codes[idx];
					if (code === 38 || code === 48) {
						if (codes[idx + 1] === 5) idx += 2;
						else if (codes[idx + 1] === 2) idx += 4;
						continue;
					}
					if (code === 7) inverse = true;
					else if (code === 0 || code === 27) inverse = false;
				}
				i = end + 1;
				continue;
			}
		}
		if (inverse) {
			current += line[i]!;
		} else if (current.length > 0) {
			runs.push(current);
			current = "";
		}
		i++;
	}
	if (current.length > 0) runs.push(current);
	return runs;
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
	return {
		path: "AGENTS.md",
		tool: "edit",
		before: "# Rules\n\n- Run the tests.\n- Keep `src/a.ts` small.\n",
		after: "# Rules\n\n- Run the tests with `npm test`.\n- Keep `src/a.ts` small.\n",
		existed: true,
		added: { findings: [] },
		...overrides,
	};
}

function mountDialog(
	input: ReviewInput,
	options: { rows?: number; keybindings?: Pick<KeybindingsManager, "matches"> | undefined } = {},
) {
	const choices: (ReviewChoice | undefined)[] = [];
	const tui = { requestRender: vi.fn(), terminal: { rows: options.rows ?? 28 } };
	const kb = "keybindings" in options ? options.keybindings : defaultKeybindings;
	const dialog = new ReviewDialog(input, tui, theme, kb, (choice) => choices.push(choice));
	return {
		dialog,
		tui,
		choices,
		press: (...keys: string[]) => {
			for (const key of keys) dialog.handleInput(key);
		},
		raw: (width = 80) => dialog.render(width),
		plain: (width = 80) => dialog.render(width).map(stripTerminalSequences),
	};
}

describe("diffStats", () => {
	it("counts added lines and a single hunk for new-file creation", () => {
		expect(diffStats("", "# Rules\n\n- First rule.\n- Second rule.\n")).toEqual({
			added: 4,
			removed: 0,
			hunks: 1,
		});
	});

	it("counts added, removed, and hunks accurately across multi-hunk edits and respects context size", () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		const after = before
			.replace("line 2\n", "LINE 2\n")
			.replace("line 18\n", "line 18\ninserted A\ninserted B\n")
			.replace("line 20\n", "");

		expect(diffStats(before, after)).toEqual({
			added: 3,
			removed: 2,
			hunks: 2,
		});

		// Two edits separated by 4 unchanged lines split under context=1 (2*1 < 4) and merge under context=3 (2*3 >= 4).
		const closeBefore = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n") + "\n";
		const closeAfter = ["1", "TWO", "3", "4", "5", "6", "SEVEN", "8"].join("\n") + "\n";
		expect(diffStats(closeBefore, closeAfter, 1)).toEqual({ added: 2, removed: 2, hunks: 2 });
		expect(diffStats(closeBefore, closeAfter, 3)).toEqual({ added: 2, removed: 2, hunks: 1 });
	});

	it("returns zero stats when only CRLF line endings or the final newline differ", () => {
		expect(diffStats("", "")).toEqual({ added: 0, removed: 0, hunks: 0 });
		expect(diffStats("alpha\nbeta", "alpha\nbeta\n")).toEqual({ added: 0, removed: 0, hunks: 0 });
		expect(diffStats("alpha\r\nbeta\r\n", "alpha\nbeta\n")).toEqual({ added: 0, removed: 0, hunks: 0 });
		expect(diffStats("alpha\r\nbeta", "alpha\nbeta\r\n")).toEqual({ added: 0, removed: 0, hunks: 0 });
	});
});

describe("renderReviewBody", () => {
	it("renders hunk headers, dual line numbers in the │ gutter, and semantic colors for -, +, and context lines", () => {
		// Hunk 1 deletes line 2 (shifting subsequent new line numbers by -1); hunk 2 inserts a line near the end.
		const beforeLines = Array.from({ length: 14 }, (_, i) => `rule ${i + 1}`);
		const afterLines = [
			"rule 1",
			// "rule 2" deleted (old line 2)
			...beforeLines.slice(2, 12),
			"added rule",
			"rule 13",
			"rule 14",
		];
		const raw = renderReviewBody(
			makeInput({ before: `${beforeLines.join("\n")}\n`, after: `${afterLines.join("\n")}\n` }),
			theme,
			90,
		);
		const plain = raw.map(stripTerminalSequences);

		// Two hunk headers.
		const hunkHeaders = plain.filter((line) => /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
		expect(hunkHeaders).toHaveLength(2);

		// Pure removed line ("rule 2" at old line 2): old line 2 in gutter, no new line number, "-" prefix, toolDiffRemoved color.
		const removedIdx = plain.findIndex((line) => line.includes("rule 2"));
		expect(removedIdx).toBeGreaterThanOrEqual(0);
		const removedPlain = plain[removedIdx]!;
		expect(removedPlain).toContain("│");
		expect(removedPlain.slice(0, removedPlain.indexOf("│")).match(/\d+/g)).toEqual(["2"]);
		expect(removedPlain).toMatch(/│\s*-\s?rule 2|-\s*│\s*rule 2/);
		expect(raw[removedIdx]).toContain(FG_ANSI.toolDiffRemoved);
		expect(raw[removedIdx]).not.toContain(FG_ANSI.toolDiffAdded);

		// Context line in hunk 2 ("rule 12" is old line 12, new line 11): both numbers appear in the gutter before │.
		const contextIdx = plain.findIndex((line) => line.includes("rule 12"));
		expect(contextIdx).toBeGreaterThanOrEqual(0);
		const contextPlain = plain[contextIdx]!;
		expect(contextPlain).toContain("│");
		expect(contextPlain.slice(0, contextPlain.indexOf("│")).match(/\d+/g)).toEqual(["12", "11"]);
		expect(raw[contextIdx]).toContain(FG_ANSI.toolDiffContext);
		expect(raw[contextIdx]).not.toContain(FG_ANSI.toolDiffRemoved);
		expect(raw[contextIdx]).not.toContain(FG_ANSI.toolDiffAdded);

		// Pure added line ("added rule" at new line 12): new line 12 in gutter, "+" prefix, toolDiffAdded color.
		const addedIdx = plain.findIndex((line) => line.includes("added rule"));
		expect(addedIdx).toBeGreaterThanOrEqual(0);
		const addedPlain = plain[addedIdx]!;
		expect(addedPlain).toContain("│");
		expect(addedPlain.slice(0, addedPlain.indexOf("│")).match(/\d+/g)).toEqual(["12"]);
		expect(addedPlain).toMatch(/│\s*\+\s?added rule|\+\s*│\s*added rule/);
		expect(raw[addedIdx]).toContain(FG_ANSI.toolDiffAdded);
		expect(raw[addedIdx]).not.toContain(FG_ANSI.toolDiffRemoved);
	});

	it("highlights intra-line changed words with inverse on 1-to-1 and 2-to-2 modified lines without inverting indentation or unchanged words", () => {
		// 1-to-1 modification where both leading indentation and the first word + a middle word change.
		const oneToOne = renderReviewBody(
			makeInput({
				before: "  oldLead keep middleOld tail\n",
				after: "    newLead keep middleNew tail\n",
			}),
			theme,
			100,
		);
		const onePlain = oneToOne.map(stripTerminalSequences);
		const oneRemIdx = onePlain.findIndex((line) => line.includes("oldLead"));
		const oneAddIdx = onePlain.findIndex((line) => line.includes("newLead"));
		expect(oneRemIdx).toBeGreaterThanOrEqual(0);
		expect(oneAddIdx).toBeGreaterThanOrEqual(0);

		expect(oneToOne[oneRemIdx]).toContain("\x1b[7m");
		expect(oneToOne[oneAddIdx]).toContain("\x1b[7m");
		const oneRemInverted = invertedRuns(oneToOne[oneRemIdx]!);
		const oneAddInverted = invertedRuns(oneToOne[oneAddIdx]!);
		expect(oneRemInverted).toEqual(["oldLead", "middleOld"]);
		expect(oneAddInverted).toEqual(["newLead", "middleNew"]);
		expect(oneRemInverted.some((span) => /^\s/.test(span))).toBe(false);
		expect(oneAddInverted.some((span) => /^\s/.test(span))).toBe(false);

		// 2-to-2 modification block.
		const twoToTwo = renderReviewBody(
			makeInput({
				before: "    - First rule uses alpha config.\n    - Second rule uses beta runner.\n",
				after: "    - First rule uses gamma config.\n    - Second rule uses delta runner.\n",
			}),
			theme,
			100,
		);
		const twoPlain = twoToTwo.map(stripTerminalSequences);
		const alphaIdx = twoPlain.findIndex((line) => line.includes("alpha"));
		const betaIdx = twoPlain.findIndex((line) => line.includes("beta"));
		const gammaIdx = twoPlain.findIndex((line) => line.includes("gamma"));
		const deltaIdx = twoPlain.findIndex((line) => line.includes("delta"));

		expect(invertedRuns(twoToTwo[alphaIdx]!)).toEqual(["alpha"]);
		expect(invertedRuns(twoToTwo[betaIdx]!)).toEqual(["beta"]);
		expect(invertedRuns(twoToTwo[gammaIdx]!)).toEqual(["gamma"]);
		expect(invertedRuns(twoToTwo[deltaIdx]!)).toEqual(["delta"]);
	});

	it("wraps long AGENTS.md lines within width and aligns wrapped continuation lines under the │ gutter", () => {
		const longRule =
			"- Keep every rule in AGENTS.md grounded in checked-in paths such as `extensions/agents-md/lint.ts` and verify edits with `npm run test:agents-md` before finishing.";
		const width = 48;
		const raw = renderReviewBody(
			makeInput({
				before: "# Rules\n",
				after: `# Rules\n${longRule}\n`,
			}),
			theme,
			width,
		);
		for (const line of raw) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const plain = raw.map(stripTerminalSequences);
		const firstIdx = plain.findIndex((line) => line.includes("Keep every rule"));
		const lastIdx = plain.findIndex((line) => line.includes("finishing."));
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(lastIdx).toBeGreaterThan(firstIdx + 1);

		const gutterCol = visibleWidth(plain[firstIdx]!.slice(0, plain[firstIdx]!.indexOf("│")));
		expect(gutterCol).toBeGreaterThan(0);

		for (let i = firstIdx + 1; i <= lastIdx; i++) {
			const cont = plain[i]!;
			expect(cont).toContain("│");
			const beforeBar = cont.slice(0, cont.indexOf("│"));
			// Continuation lines leave line-number columns blank rather than spilling text to column 0.
			expect(beforeBar.trim()).toBe("");
			expect(visibleWidth(beforeBar)).toBe(gutterCol);
			expect(raw[i]).toContain(FG_ANSI.toolDiffAdded);
		}
	});

	it("renders clean lint status, new lint findings with count and warning icon, and lint errors", () => {
		const clean = renderReviewBody(makeInput({ added: { findings: [] } }), theme, 120)
			.map(stripTerminalSequences)
			.join("\n");
		expect(clean).toContain("No new lint findings.");

		const withFindings = renderReviewBody(
			makeInput({
				added: {
					findings: [
						{ kind: "dead-path", line: 4, message: "`docs/missing.md` names no file in the repository." },
						{ kind: "budget", message: "The file is longer than 200 lines, and every session loads it in full." },
					],
				},
			}),
			theme,
			120,
		)
			.map(stripTerminalSequences)
			.join("\n");
		expect(withFindings).toContain("⚠ New lint findings (2):");
		expect(withFindings).toContain("line 4: `docs/missing.md` names no file in the repository.");
		expect(withFindings).toContain("The file is longer than 200 lines, and every session loads it in full.");

		const withError = renderReviewBody(makeInput({ added: { error: "lint subprocess failed" } }), theme, 120)
			.map(stripTerminalSequences)
			.join("\n");
		expect(withError).toContain("Lint could not run: lint subprocess failed");
	});
});

describe("ReviewDialog", () => {
	it("renders header with path, action (edits/creates/rewrites), +added -removed stats, and choices within terminal bounds", () => {
		const cases = [
			{
				label: "edits",
				input: makeInput({
					path: "AGENTS.md",
					tool: "edit",
					existed: true,
					before: "a\nb\n",
					after: "a\nB\nc\nd\n",
				}),
				expectedTokens: ["+3", "-1"],
			},
			{
				label: "creates",
				input: makeInput({
					path: "extensions/demo/CLAUDE.md",
					tool: "write",
					existed: false,
					before: "",
					after: "- One.\n- Two.\n",
				}),
				expectedTokens: ["+2"],
			},
			{
				label: "rewrites",
				input: makeInput({
					path: "CLAUDE.md",
					tool: "write",
					existed: true,
					before: "old 1\nold 2\n",
					after: "new 1\n",
				}),
				expectedTokens: ["+1", "-2"],
			},
		] as const;

		for (const { label, input, expectedTokens } of cases) {
			const { dialog, plain } = mountDialog(input, { rows: 24 });
			const lines = plain(80);
			expect(lines.length).toBeLessThanOrEqual(24);
			for (const rawLine of dialog.render(80)) {
				expect(visibleWidth(rawLine)).toBeLessThanOrEqual(80);
			}
			const full = lines.join("\n");
			expect(full).toContain(input.path);
			expect(full).toContain(label);
			for (const token of expectedTokens) {
				expect(full).toContain(token);
			}
			expect(full).toContain("Apply");
			expect(full).toContain("Reject");
			expect(full).toContain("Reject with a note");
		}

		// Never exceeds terminal.rows or width even on cramped terminals with long diffs, keeps the active choice visible, and supports invalidate().
		const hugeAfter = Array.from({ length: 150 }, (_, i) => `- Long rule ${i + 1}: ${"word ".repeat(20)}`).join("\n") + "\n";
		for (const [width, rows] of [[80, 26], [42, 12], [28, 6], [20, 3], [18, 1]] as const) {
			const { dialog, press } = mountDialog(makeInput({ before: "", after: hugeAfter, existed: false, tool: "write" }), { rows });
			const firstRender = dialog.render(width);
			expect(firstRender.length).toBeLessThanOrEqual(rows);
			for (const line of firstRender) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(firstRender.map(stripTerminalSequences).join("\n")).toContain("▸ Apply");
			dialog.invalidate();
			expect(dialog.render(width)).toEqual(firstRender);

			// Cycling choices on tiny terminals keeps the newly selected choice visible.
			press(KEYS.right);
			expect(dialog.render(width).map(stripTerminalSequences).join("\n")).toContain("▸ Reject");
			press(KEYS.right);
			expect(dialog.render(width).map(stripTerminalSequences).join("\n")).toContain("▸ Reject");
		}
	});

	it("cycles choices with →/Tab and ←/Shift+Tab, confirms with Enter, cancels with Esc, and answers on quick keys a/r/n", () => {
		const input = makeInput();

		// Default selection is Apply; cycling forward wraps across all three choices.
		const cycleForward = mountDialog(input);
		const renderApply = cycleForward.raw().join("\n");
		cycleForward.press(KEYS.right);
		const renderReject = cycleForward.raw().join("\n");
		cycleForward.press(KEYS.tab);
		const renderNote = cycleForward.raw().join("\n");
		cycleForward.press(KEYS.right);
		const renderWrapped = cycleForward.raw().join("\n");
		expect(renderReject).not.toBe(renderApply);
		expect(renderNote).not.toBe(renderReject);
		expect(renderNote).not.toBe(renderApply);
		expect(renderWrapped).toBe(renderApply);
		expect(cycleForward.choices).toEqual([]);

		// Confirming each cycled position with Enter.
		const enterDefault = mountDialog(input);
		enterDefault.press(KEYS.enter);
		expect(enterDefault.choices).toEqual(["Apply"]);

		const enterRight = mountDialog(input);
		enterRight.press(KEYS.right, KEYS.enter);
		expect(enterRight.choices).toEqual(["Reject"]);

		const enterTwoTabs = mountDialog(input);
		enterTwoTabs.press(KEYS.tab, KEYS.tab, KEYS.enter);
		expect(enterTwoTabs.choices).toEqual(["Reject with a note"]);

		// Backward cycling with ← and Shift+Tab wraps from Apply to Reject with a note, then Reject.
		const enterLeft = mountDialog(input);
		enterLeft.press(KEYS.left, KEYS.enter);
		expect(enterLeft.choices).toEqual(["Reject with a note"]);

		const enterShiftTabTwice = mountDialog(input);
		enterShiftTabTwice.press(KEYS.shiftTab, KEYS.shiftTab, KEYS.enter);
		expect(enterShiftTabTwice.choices).toEqual(["Reject"]);

		// Esc cancels with undefined; quick keys a / r / n resolve immediately (both with keybindings and without).
		const cancelled = mountDialog(input);
		cancelled.press("x", KEYS.esc);
		expect(cancelled.choices).toEqual([undefined]);

		const cancelledNoKb = mountDialog(input, { keybindings: undefined });
		cancelledNoKb.press(KEYS.esc);
		expect(cancelledNoKb.choices).toEqual([undefined]);

		const quickA = mountDialog(input);
		quickA.press("a");
		const quickR = mountDialog(input);
		quickR.press("r");
		const quickN = mountDialog(input, { keybindings: undefined });
		quickN.press("n");
		expect([quickA.choices, quickR.choices, quickN.choices]).toEqual([
			["Apply"],
			["Reject"],
			["Reject with a note"],
		]);
	});

	it("scrolls overflowing diffs with j/↓, k/↑, PageDown/space, Home/g, and End/G, clamped cleanly with lines X-Y of Z", () => {
		// Short diffs fit without showing a scroll range.
		const short = mountDialog(makeInput(), { rows: 30 });
		expect(short.plain().some((line) => /lines \d+-\d+ of \d+/.test(line))).toBe(false);

		// Overflowing diff in a 24-row terminal.
		const manyLines = Array.from({ length: 120 }, (_, i) => `- Rule number ${i + 1}`).join("\n") + "\n";
		const view = mountDialog(
			makeInput({ before: "", after: manyLines, tool: "write", existed: false }),
			{ rows: 24 },
		);

		const range = () => {
			for (const line of view.plain(80)) {
				const match = /lines (\d+)-(\d+) of (\d+)/.exec(line);
				if (match) {
					return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
				}
			}
			return undefined;
		};

		const initial = range()!;
		expect(initial).toBeDefined();
		expect(initial.start).toBe(1);
		expect(initial.end).toBeLessThan(initial.total);
		const viewport = initial.end - initial.start + 1;

		// Clamped at top on ↑ and k.
		view.press(KEYS.up, "k");
		expect(range()).toEqual(initial);

		// Single-line scroll down with ↓ and j, then back up with k and ↑.
		view.press(KEYS.down);
		expect(range()).toEqual({ start: 2, end: 1 + viewport, total: initial.total });
		view.press("j");
		expect(range()).toEqual({ start: 3, end: 2 + viewport, total: initial.total });
		view.press("k");
		expect(range()).toEqual({ start: 2, end: 1 + viewport, total: initial.total });
		view.press(KEYS.up);
		expect(range()).toEqual(initial);

		// Page scrolling with PageDown, space, and PageUp.
		view.press(KEYS.pageDown);
		const afterPageDown = range()!;
		expect(afterPageDown.start).toBeGreaterThan(2);
		view.press(KEYS.space);
		const afterSpace = range()!;
		expect(afterSpace.start).toBeGreaterThan(afterPageDown.start);
		view.press(KEYS.pageUp);
		expect(range()!.start).toBeLessThan(afterSpace.start);

		// End and G jump to the bottom and clamp against further downward scrolling; Home and g jump back to top.
		view.press(KEYS.end, KEYS.down, "j", KEYS.pageDown);
		const atBottom = range()!;
		expect(atBottom.end).toBe(initial.total);
		expect(atBottom.start).toBe(initial.total - viewport + 1);

		view.press("g");
		expect(range()).toEqual(initial);

		view.press("G");
		expect(range()).toEqual(atBottom);

		view.press(KEYS.home);
		expect(range()).toEqual(initial);

		// Mouse wheel scrolling moves the diff viewport cleanly and clamps at top.
		const wheel = (wheelDelta: number) => ({
			type: "wheel" as const,
			button: "none" as const,
			x: 5,
			y: 5,
			screenX: 5,
			screenY: 5,
			width: 80,
			height: 24,
			wheelDelta,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(view.dialog.handleMouse(wheel(3))).toEqual({ handled: true });
		expect(range()!.start).toBe(4);
		expect(view.dialog.handleMouse(wheel(-10))).toEqual({ handled: true });
		expect(range()).toEqual(initial);
		expect(view.tui.requestRender).toHaveBeenCalled();
	});

	it("keeps Apply, Reject, and Reject with a note visible on a crowded fullscreen TUI viewport for a large AGENTS.md diff", () => {
		const writes: string[] = [];
		const fakeTerminal = {
			columns: 90,
			rows: 26,
			kittyProtocolActive: false,
			start() {},
			stop() {},
			async drainInput() {},
			write(data: string) {
				writes.push(data);
			},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
		} as unknown as Terminal;

		const tui = new TuiAltScreen(fakeTerminal);
		const doc = new Container();
		for (let i = 1; i <= 40; i++) doc.addChild(new Text(`transcript line ${i}`, 0, 0));
		const status = new Text("⠋ Editing AGENTS.md...\n", 0, 0);
		const widgetsAbove = new Container();
		for (let i = 1; i <= 10; i++) widgetsAbove.addChild(new Text(`subagent widget line ${i}`, 0, 0));
		const editorSlot = new Container();
		editorSlot.addChild(new Text("editor placeholder", 0, 0));
		const footer = new Text("statusline row 1\nstatusline row 2\nstatusline row 3", 0, 0);

		const transcript = new ScrollView(doc, { follow: "end", primary: true });
		const dock = new VStack([
			{ component: status, shrink: 1, minSize: 0 },
			{ component: widgetsAbove, shrink: 1, minSize: 0 },
			{ component: editorSlot, shrink: 1, minSize: 3 },
			{ component: footer, shrink: 1, minSize: 0 },
		]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);

		const largeBefore = Array.from({ length: 120 }, (_, i) => `- Existing rule ${i + 1}: keep it verified.`).join("\n") + "\n";
		const largeAfter = Array.from({ length: 160 }, (_, i) => `- Updated rule ${i + 1}: keep \`src/a.ts\` verified.`).join("\n") + "\n";
		const dialog = new ReviewDialog(
			makeInput({ before: largeBefore, after: largeAfter }),
			tui,
			theme,
			defaultKeybindings,
			() => {},
		);

		tui.start();
		try {
			writes.length = 0;
			tui.showOverlay(dialog, REVIEW_OVERLAY_OPTIONS);
			tui.renderNow(true);
			const renderedOutput = stripTerminalSequences(writes.join(""));
			expect(renderedOutput).toContain("Review AGENTS.md");
			expect(renderedOutput).toContain("▸ Apply");
			expect(renderedOutput).toContain("Reject");
			expect(renderedOutput).toContain("Reject with a note");
		} finally {
			tui.stop();
		}
	});
});

describe("promptReviewDialog and reviewToolCall TUI custom UI", () => {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

	const RULES = "# Rules\n\n- Run the tests.\n- Keep `src/a.ts` small.\n";
	let root: string;
	let repo: string;

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-agents-md-review-ui-")));
		repo = join(root, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "true" } }));
		writeFileSync(join(repo, "AGENTS.md"), RULES);
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		writeFileSync(join(repo, "AGENTS.md"), RULES);
	});

	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY];
	});

	it("resolves undefined immediately when signal is already aborted and closes with undefined when aborted mid-review", async () => {
		const preAborted = new AbortController();
		preAborted.abort();
		const unusedCustom = vi.fn();
		const preCtx = { ui: { custom: unusedCustom } } as unknown as Pick<ExtensionContext, "ui">;
		await expect(promptReviewDialog(preCtx, makeInput(), preAborted.signal)).resolves.toBeUndefined();
		expect(unusedCustom).not.toHaveBeenCalled();

		const midController = new AbortController();
		const midCustom = vi.fn(
			(
				factory: (
					tui: { requestRender(): void; terminal: { rows: number } },
					th: Theme,
					kb: KeybindingsManager,
					done: (choice: ReviewChoice | undefined) => void,
				) => Component | Promise<Component>,
			) =>
				new Promise<ReviewChoice | undefined>((resolve) => {
					void factory({ requestRender() {}, terminal: { rows: 28 } }, theme, defaultKeybindings, resolve);
				}),
		);
		const midCtx = { ui: { custom: midCustom } } as unknown as Pick<ExtensionContext, "ui">;
		const pending = promptReviewDialog(midCtx, makeInput(), midController.signal);
		expect(midCustom).toHaveBeenCalledTimes(1);
		midController.abort();
		await expect(pending).resolves.toBeUndefined();
	});

	it("uses ui.custom in TUI mode for Apply, Reject, and Reject with a note, and falls back to ui.select in RPC mode", async () => {
		const makeContext = (options: {
			mode: "tui" | "rpc";
			pressKey?: string;
			selectAnswer?: ReviewChoice | undefined;
			note?: string;
		}) => {
			let mounted: Component | undefined;
			const custom = vi.fn(
				(
					factory: (
						tui: { requestRender(): void; terminal: { rows: number } },
						th: Theme,
						kb: KeybindingsManager,
						done: (choice: ReviewChoice | undefined) => void,
					) => Component | Promise<Component>,
					_customOptions?: unknown,
				) =>
					new Promise<ReviewChoice | undefined>((resolve) => {
						void Promise.resolve(
							factory({ requestRender() {}, terminal: { rows: 28 } }, theme, defaultKeybindings, resolve),
						).then((component) => {
							mounted = component;
							if (options.pressKey !== undefined) component.handleInput?.(options.pressKey);
						});
					}),
			);
			const select = vi.fn(async () => options.selectAnswer);
			const input = vi.fn(async () => options.note);
			const ctx = {
				cwd: repo,
				hasUI: true,
				mode: options.mode,
				signal: undefined,
				sessionManager: { getEntries: () => [] },
				ui: { custom, select, input },
			} as unknown as ExtensionContext;
			return { ctx, custom, select, input, getMounted: () => mounted };
		};

		const editArgs = {
			path: "AGENTS.md",
			edits: [{ oldText: "- Run the tests.", newText: "- Read `docs/missing.md` before running tests." }],
		};

		// 1. TUI + Apply via ReviewDialog ("a"), mounted as a bottom-anchored overlay so dock widgets cannot clip choices
		const applyCase = makeContext({ mode: "tui", pressKey: "a" });
		await expect(reviewToolCall("edit", editArgs, applyCase.ctx)).resolves.toBeUndefined();
		expect(applyCase.custom).toHaveBeenCalledTimes(1);
		expect(applyCase.custom.mock.calls[0]?.[1]).toEqual({
			overlay: true,
			overlayOptions: REVIEW_OVERLAY_OPTIONS,
			blocked: { kind: "permission", message: "Review AGENTS.md" },
		});
		expect(applyCase.getMounted()).toBeInstanceOf(ReviewDialog);
		const renderedText = applyCase.getMounted()!.render(90).map(stripTerminalSequences).join("\n");
		expect(renderedText).toContain("AGENTS.md");
		expect(renderedText).toContain("⚠ New lint findings (1):");
		expect(applyCase.select).not.toHaveBeenCalled();
		expect(applyCase.input).not.toHaveBeenCalled();

		// 2. TUI + Reject via ReviewDialog ("r")
		const rejectCase = makeContext({ mode: "tui", pressKey: "r" });
		await expect(reviewToolCall("edit", editArgs, rejectCase.ctx)).resolves.toEqual({
			block: true,
			reason: reasons.rejected("AGENTS.md"),
		});
		expect(rejectCase.custom).toHaveBeenCalledTimes(1);
		expect(rejectCase.select).not.toHaveBeenCalled();
		expect(rejectCase.input).not.toHaveBeenCalled();

		// 3. TUI + Reject with a note via ReviewDialog ("n") -> still prompts ui.input
		const noteCase = makeContext({ mode: "tui", pressKey: "n", note: "  keep the existing test rule.  " });
		await expect(reviewToolCall("edit", editArgs, noteCase.ctx)).resolves.toEqual({
			block: true,
			reason: "The user rejected this change to AGENTS.md: keep the existing test rule. Do not retry it unchanged.",
		});
		expect(noteCase.custom).toHaveBeenCalledTimes(1);
		expect(noteCase.select).not.toHaveBeenCalled();
		expect(noteCase.input).toHaveBeenCalledWith("Why reject the change to AGENTS.md?", "a note for the agent", {
			signal: undefined,
		});

		// 4. RPC mode with ui.custom present -> must use ui.select, never ui.custom
		const rpcCase = makeContext({ mode: "rpc", selectAnswer: CHOICES.apply });
		await expect(reviewToolCall("edit", editArgs, rpcCase.ctx)).resolves.toBeUndefined();
		expect(rpcCase.select).toHaveBeenCalledTimes(1);
		expect(rpcCase.custom).not.toHaveBeenCalled();
	});
});
