import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	type Answer,
	confirmDelivery,
	confirmLong,
	type GoalChoice,
	GoalReviewDialog,
	renderGoalMarkdown,
	renderSummaryLines,
	reviewGoal,
	ScrollableConfirm,
} from "../../src/adapter/confirm.ts";

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	tab: "\t",
	shiftTab: "\x1b[Z",
	enter: "\r",
	esc: "\x1b",
};
const keybindings = {
	matches: (data: string, binding: string) =>
		({
			"tui.select.up": KEYS.up,
			"tui.select.down": KEYS.down,
			"tui.select.pageUp": KEYS.pageUp,
			"tui.select.pageDown": KEYS.pageDown,
			"tui.select.confirm": KEYS.enter,
			"tui.select.cancel": KEYS.esc,
		} as Record<string, string>)[binding] === data,
};
const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
} as unknown as Theme;

function createTrackingTheme() {
	const tokens = new Map<ThemeColor, string[]>();
	const tracked = {
		fg: (color: ThemeColor, text: string) => {
			const bucket = tokens.get(color) ?? [];
			bucket.push(text);
			tokens.set(color, bucket);
			return `\x1b[36m${text}\x1b[39m`;
		},
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
	} as unknown as Theme;
	return { theme: tracked, tokens };
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const LONG = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");

const SAMPLE_GOAL = `# Goal: Add a --json flag

## Intent
Scripts need \`--json\` output from **export**.

## Acceptance criteria
- AC-1: WHEN export runs with \`--json\` THE SYSTEM SHALL print valid JSON. verify: check:unit-tests
- AC-2: Help text lists \`--json\` clearly across narrow terminals as well. verify: judge — rubric: "help lists --json"

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| unit-tests | npm test | 5m | yes |

## Constraints
\`\`\`bash
# heading-like comment inside fence
export --json
\`\`\`
`;

function dialog(body: string, rows = 30) {
	const answers: Answer[] = [];
	const tui = { requestRender: vi.fn(), terminal: { rows } };
	const component = new ScrollableConfirm("Approve Herder goal: X", body, tui, theme, keybindings, (yes) => answers.push(yes));
	return { component, answers, tui, press: (...keys: string[]) => { for (const key of keys) component.handleInput(key); }, text: (width = 80) => component.render(width).map(plain) };
}

describe("ScrollableConfirm", () => {
	it("keeps the choice on screen and answerable however long the body is", () => {
		for (const [key, answer] of [["y", true], ["n", false]] as const) {
			const { text, press, answers } = dialog(LONG, 30);
			const lines = text();
			expect(lines.length).toBeLessThanOrEqual(30);
			expect(lines.some((line) => line.includes("▸ Yes") && line.includes("No"))).toBe(true);
			expect(lines).toContain(" line 1");
			expect(lines).not.toContain(" line 200");
			expect(lines.some((line) => /lines 1-\d+ of 200 · \d+ more below/.test(line))).toBe(true);
			press(key);
			expect(answers).toEqual([answer]);
		}
	});

	it("never answers on scroll or choice keys", () => {
		const { press, answers, text } = dialog(LONG, 30);
		press(KEYS.down, "j", KEYS.pageDown, " ", KEYS.end, "G", KEYS.up, "k", KEYS.pageUp, KEYS.home, "g", KEYS.left, KEYS.right, KEYS.tab, "x");
		expect(answers).toEqual([]);
		// Three toggles leave No highlighted.
		expect(text().some((line) => line.includes("▸ No"))).toBe(true);
	});

	it("shows a short body whole, without a scroll status", () => {
		const lines = dialog("one\ntwo", 30).text();
		expect(lines).toEqual(expect.arrayContaining([" one", " two"]));
		expect(lines.some((line) => line.includes("lines "))).toBe(false);
	});

	it("scrolls by line, page, and to the end, clamped to the body", () => {
		const { press, text, tui } = dialog(LONG, 30);
		press(KEYS.up);
		expect(text()).toContain(" line 1");
		press(KEYS.down);
		expect(text()).toContain(" line 2");
		expect(text()).not.toContain(" line 1");
		press(KEYS.pageDown);
		expect(text()).not.toContain(" line 2");
		press(KEYS.end, KEYS.down);
		const lines = text();
		expect(lines).toContain(" line 200");
		expect(lines.some((line) => line.endsWith("of 200 · end"))).toBe(true);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("answers with y, n, and enter on the highlighted choice; esc closes without an answer", () => {
		const yes = dialog(LONG);
		yes.press("y");
		const no = dialog(LONG);
		no.press("n");
		const esc = dialog(LONG);
		esc.press(KEYS.esc);
		const enter = dialog(LONG);
		enter.press(KEYS.enter);
		const switched = dialog(LONG);
		switched.press(KEYS.left);
		expect(switched.text().some((line) => line.includes("▸ No"))).toBe(true);
		switched.press(KEYS.enter);
		expect([yes.answers, no.answers, esc.answers, enter.answers, switched.answers]).toEqual([[true], [false], [undefined], [true], [false]]);
	});

	it("fits every line to narrow widths and tiny terminals", () => {
		for (const width of [10, 40]) for (const rows of [3, 12]) {
			for (const line of dialog(`${"word ".repeat(80)}\n${LONG}`, rows).component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("confirmLong", () => {
	const ctx = (mode: string, custom = vi.fn(), confirm = vi.fn(async () => true)) => ({ mode, ui: { custom, confirm } }) as unknown as ExtensionContext & { ui: { custom: typeof custom; confirm: typeof confirm } };

	it("uses ui.confirm outside the TUI, passing the signal", async () => {
		const context = ctx("rpc");
		const signal = new AbortController().signal;
		await expect(confirmLong(context, "T", "B", signal)).resolves.toBe(true);
		expect(context.ui.confirm).toHaveBeenCalledWith("T", "B", { signal });
		expect(context.ui.custom).not.toHaveBeenCalled();
	});

	it("shows the scrollable dialog in the TUI and returns its answer", async () => {
		const custom = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve).handleInput("y");
		}));
		const context = ctx("tui", custom);
		await expect(confirmLong(context, "T", LONG)).resolves.toBe(true);
		expect(context.ui.confirm).not.toHaveBeenCalled();
	});

	it("returns a deliberate no, and no answer for an abort", async () => {
		const no = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve).handleInput("n");
		}));
		await expect(confirmLong(ctx("tui", no), "T", LONG)).resolves.toBe(false);
		const controller = new AbortController();
		const custom = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve);
		}));
		const answer = confirmLong(ctx("tui", custom), "T", LONG, controller.signal);
		controller.abort();
		await expect(answer).resolves.toBeUndefined();
		await expect(confirmLong(ctx("tui", custom), "T", LONG, controller.signal)).resolves.toBeUndefined();
		expect(custom).toHaveBeenCalledTimes(1);
	});
});

describe("confirmDelivery & renderSummaryLines", () => {
	const SUMMARY = [
		"Deliver Herder run 20260101-000000-abcd (Update server) as series to main.",
		"Commits (oldest first):",
		"  111111111111 Update server config",
		"Changes:",
		" src/server.ts | 6 +++---",
		" 5 files changed, 6 insertions(+), 5 deletions(-)",
	].join("\n");

	it("styles headings and diffstat bars without showing a unified diff", () => {
		const { theme: tracked, tokens } = createTrackingTheme();
		const lines = renderSummaryLines(SUMMARY, 90, tracked).map(plain);
		expect(lines.some((line) => line.includes("Update server config"))).toBe(true);
		expect(lines.some((line) => line.includes("src/server.ts | 6 +++---"))).toBe(true);
		expect(tokens.get("toolDiffAdded")).toEqual(["+++"]);
		expect(tokens.get("toolDiffRemoved")).toEqual(["---"]);
		expect(tokens.get("muted")?.some((s) => s.includes("5 files changed"))).toBe(true);
	});

	it("confirmDelivery uses ui.confirm in RPC and ScrollableConfirm with styled summary in TUI", async () => {
		const rpcConfirm = vi.fn(async () => true);
		const rpcCustom = vi.fn();
		const rpcCtx = { mode: "rpc", ui: { confirm: rpcConfirm, custom: rpcCustom } } as unknown as ExtensionContext;
		await expect(confirmDelivery(rpcCtx, "Deliver?", SUMMARY)).resolves.toBe(true);
		expect(rpcConfirm).toHaveBeenCalledWith("Deliver?", SUMMARY, { signal: undefined });
		expect(rpcCustom).not.toHaveBeenCalled();

		const { theme: tracked, tokens } = createTrackingTheme();
		const tuiCustom = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			const comp = factory({ requestRender() {}, terminal: { rows: 30 } }, tracked, keybindings, resolve);
			const rendered = comp.render(80).map(plain);
			expect(rendered.some((line) => line.includes("Update server config"))).toBe(true);
			expect(rendered.some((line) => line.includes("5 files changed"))).toBe(true);
			expect(tokens.get("toolDiffAdded")).toEqual(["+++"]);
			expect(tokens.get("toolDiffRemoved")).toEqual(["---"]);
			comp.handleInput("y");
		}));
		const tuiCtx = { mode: "tui", ui: { confirm: rpcConfirm, custom: tuiCustom } } as unknown as ExtensionContext;
		await expect(confirmDelivery(tuiCtx, "Deliver?", SUMMARY)).resolves.toBe(true);
	});
});

describe("GoalReviewDialog & reviewGoal", () => {
	function goalDialog(markdown = SAMPLE_GOAL, rows = 32) {
		const choices: Array<GoalChoice | undefined> = [];
		const tui = { requestRender: vi.fn(), terminal: { rows } };
		const { theme: tracked, tokens } = createTrackingTheme();
		const component = new GoalReviewDialog("Approve Herder goal: Add a --json flag", markdown, "The goal is frozen once approved.", tui, tracked, keybindings, (choice) => choices.push(choice));
		return {
			component,
			choices,
			tui,
			tokens,
			press: (...keys: string[]) => { for (const key of keys) component.handleInput(key); },
			text: (width = 90) => component.render(width).map(plain),
		};
	}

	it("styles headings, code fences, inline code, tables, and list bullets with theme tokens", () => {
		const { text, tokens, component } = goalDialog(SAMPLE_GOAL, 40);
		const lines = text(90);

		expect(tokens.get("mdHeading")?.some((s) => s.includes("# Goal: Add a --json flag"))).toBe(true);
		expect(tokens.get("mdHeading")?.some((s) => s.includes("## Acceptance criteria"))).toBe(true);
		// Heading-like line inside fenced code block uses mdCodeBlock, not mdHeading
		expect(tokens.get("mdHeading")?.some((s) => s.includes("heading-like comment"))).toBe(false);
		expect(tokens.get("mdCodeBlockBorder")?.some((s) => s.includes("```bash"))).toBe(true);
		expect(tokens.get("mdCodeBlock")?.some((s) => s.includes("# heading-like comment inside fence"))).toBe(true);
		expect(tokens.get("mdCode")?.some((s) => s.includes("`--json`"))).toBe(true);
		expect(tokens.get("mdListBullet")).toEqual(["-", "-"]);
		expect(tokens.get("borderMuted")?.some((s) => s.includes("┼") || s.includes("│"))).toBe(true);

		expect(lines.some((line) => line.includes("│ id") && line.includes("│ command"))).toBe(true);
		expect(lines.some((line) => line.includes("The goal is frozen once approved."))).toBe(true);
		expect(lines.some((line) => line.includes("▸ Approve") && line.includes("Reject") && line.includes("Reject with a note"))).toBe(true);

		for (const width of [10, 28, 50, 90]) {
			for (const line of renderGoalMarkdown(SAMPLE_GOAL, "The goal is frozen once approved.", width, theme)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("supports Approve, Reject, and Reject with a note via arrows/tab + enter, quick keys, esc, and scrolling", () => {
		const nav = goalDialog(`${SAMPLE_GOAL}\n${LONG}`, 24);
		nav.press(KEYS.down, "j", KEYS.pageDown, " ", "G", KEYS.up, "k", KEYS.pageUp, "g");
		expect(nav.choices).toEqual([]);

		// Cycle choices with right/tab and left/shift+tab
		nav.press(KEYS.right);
		expect(nav.text().some((line) => line.includes("▸ Reject") && !line.includes("▸ Reject with"))).toBe(true);
		nav.press(KEYS.tab);
		expect(nav.text().some((line) => line.includes("▸ Reject with a note"))).toBe(true);
		nav.press(KEYS.shiftTab);
		expect(nav.text().some((line) => line.includes("▸ Reject") && !line.includes("▸ Reject with"))).toBe(true);
		nav.press(KEYS.left);
		expect(nav.text().some((line) => line.includes("▸ Approve"))).toBe(true);
		nav.press(KEYS.tab, KEYS.tab, KEYS.enter);
		expect(nav.choices).toEqual(["reject_note"]);

		for (const [key, expected] of [
			["y", "approve"],
			["a", "approve"],
			["n", "reject"],
			["r", "reject"],
			["e", "reject_note"],
			[KEYS.esc, undefined],
		] as const) {
			const d = goalDialog();
			d.press(key);
			expect(d.choices).toEqual([expected]);
		}
	});

	it("reviewGoal keeps RPC on ui.confirm and prompts ui.input on Reject with a note in TUI", async () => {
		const rpcConfirm = vi.fn(async () => false);
		const rpcCtx = { mode: "rpc", ui: { confirm: rpcConfirm, custom: vi.fn(), input: vi.fn() } } as unknown as ExtensionContext;
		await expect(reviewGoal(rpcCtx, "Approve", SAMPLE_GOAL)).resolves.toEqual({ choice: "reject" });
		expect(rpcConfirm).toHaveBeenCalledTimes(1);

		const makeTui = (key: string, noteInput?: string) => {
			const input = vi.fn(async () => noteInput);
			const custom = vi.fn((factory: (...args: unknown[]) => GoalReviewDialog) => new Promise((resolve) => {
				factory({ requestRender() {}, terminal: { rows: 28 } }, theme, keybindings, resolve).handleInput(key);
			}));
			return { ctx: { mode: "tui", ui: { confirm: vi.fn(), custom, input } } as unknown as ExtensionContext, input };
		};

		const approved = makeTui("a");
		await expect(reviewGoal(approved.ctx, "Approve", SAMPLE_GOAL)).resolves.toEqual({ choice: "approve" });
		expect(approved.input).not.toHaveBeenCalled();

		const rejected = makeTui("r");
		await expect(reviewGoal(rejected.ctx, "Approve", SAMPLE_GOAL)).resolves.toEqual({ choice: "reject" });
		expect(rejected.input).not.toHaveBeenCalled();

		const noted = makeTui("e", "  Split AC-1 into unit and e2e checks  ");
		const signal = new AbortController().signal;
		await expect(reviewGoal(noted.ctx, "Approve", SAMPLE_GOAL, "The goal is frozen once approved.", signal)).resolves.toEqual({
			choice: "reject",
			note: "Split AC-1 into unit and e2e checks",
		});
		expect(noted.input).toHaveBeenCalledWith("What should change in goal.md?", "a note for the agent", { signal });

		const blankNote = makeTui("e", "   ");
		await expect(reviewGoal(blankNote.ctx, "Approve", SAMPLE_GOAL)).resolves.toEqual({ choice: "reject" });

		const dismissedNote = makeTui("e", undefined);
		await expect(reviewGoal(dismissedNote.ctx, "Approve", SAMPLE_GOAL)).resolves.toEqual({ choice: "reject" });
	});
});
