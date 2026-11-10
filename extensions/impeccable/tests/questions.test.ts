import type { ExtensionContext, ExtensionUIContext, Theme, ThemeBg, ThemeColor, ThemeStyle } from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, isFocusable, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { askQuestions } from "../src/questions.ts";

const questions = [
	{ id: "approve", question: "Approve?", choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No", description: "Keep exploring" }], allowFreeText: true },
	{ id: "purpose", question: "What is the purpose?", description: "Describe the visitor's goal" },
];
function context(select = vi.fn(), input = vi.fn(), hasUI = true) {
	return { hasUI, ui: { select, input } } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;
}

describe("structured question outcomes", () => {
	it("preserves No, stable choice ids, descriptions and exact free text without a confirm dialog", async () => {
		const ctx = context(vi.fn().mockResolvedValue("No — Keep exploring"), vi.fn().mockResolvedValue("  actual purpose\nsecond line  "));
		const result = await askQuestions({ questions }, ctx);
		expect(result).toMatchObject({ status: "answered", answers: [{ id: "approve", choiceId: "no", value: "No" }, { id: "purpose", value: "  actual purpose\nsecond line  " }], pending: [] });
		expect(ctx.ui.select).toHaveBeenCalledWith("Approve?", expect.arrayContaining(["No — Keep exploring"]), expect.not.objectContaining({ timeout: expect.anything() }));
		expect(ctx.ui.input).toHaveBeenCalledWith(expect.stringContaining("Describe the visitor's goal"), "Your answer", expect.anything());
	});
	it("shows ids only to tell duplicate labels apart and maps the selection to its choice", async () => {
		const select = vi.fn().mockResolvedValue("Keep (b)");
		const result = await askQuestions({ questions: [{ id: "pick", question: "Which?", choices: [{ id: "a", label: "Keep" }, { id: "b", label: "Keep" }, { id: "c", label: "Drop" }] }] }, context(select));
		expect(select).toHaveBeenCalledWith("Which?", ["Keep (a)", "Keep (b)", "Drop"], expect.anything());
		expect(result.answers).toEqual([{ id: "pick", value: "Keep", choiceId: "b" }]);
	});
	it("allows a custom answer and retains an explicitly submitted empty string", async () => {
		const result = await askQuestions({ questions: [questions[0]!] }, context(vi.fn().mockResolvedValue("Other: type your own answer"), vi.fn().mockResolvedValue("")));
		expect(result.answers).toEqual([{ id: "approve", value: "" }]);
		expect(result.status).toBe("answered");
	});
	it("records partial answers and stops at dismissal with no default for later questions", async () => {
		const input = vi.fn().mockResolvedValue(undefined);
		const result = await askQuestions({ questions }, context(vi.fn().mockResolvedValue("Yes"), input));
		expect(result.status).toBe("dismissed");
		expect(result.answers).toEqual([{ id: "approve", value: "Yes", choiceId: "yes" }]);
		expect(result.pending).toEqual([questions[1]]);
		expect(result.message).toContain("wait");
	});
	it("distinguishes tool cancellation during a dialog and preserves earlier answers", async () => {
		const controller = new AbortController();
		const input = vi.fn(async (_title, _placeholder, opts) => {
			expect(opts.signal).toBe(controller.signal);
			controller.abort();
			return undefined;
		});
		const result = await askQuestions({ questions }, context(vi.fn().mockResolvedValue("No — Keep exploring"), input), controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.answers).toEqual([{ id: "approve", value: "No", choiceId: "no" }]);
		expect(result.pending).toEqual([questions[1]]);
	});
	it("does not open UI after a pre-aborted request", async () => {
		const ctx = context();
		const result = await askQuestions({ questions }, ctx, AbortSignal.abort());
		expect(result.status).toBe("cancelled");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
	it("returns usable chat instructions immediately without UI", async () => {
		const ctx = context(vi.fn(), vi.fn(), false);
		const result = await askQuestions({ questions }, ctx);
		expect(result).toMatchObject({ status: "unavailable", answers: [], pending: questions });
		expect(result.message).toContain("chat and wait");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
	it("reports a UI failure without discarding partial answers", async () => {
		const result = await askQuestions({ questions }, context(vi.fn().mockResolvedValue("Yes"), vi.fn().mockRejectedValue(new Error("UI disconnected"))));
		expect(result.status).toBe("unavailable");
		expect(result.answers).toHaveLength(1);
		expect(result.message).toContain("UI disconnected");
	});
	it.each([
		{ questions: [questions[0], { ...questions[1], id: "approve" }] },
		{ questions: [questions[0], { ...questions[1], id: "bad id" }] },
		{ questions: [questions[0], { ...questions[1], choices: [{ id: "same", label: "A" }, { id: "same", label: "B" }] }] },
		{ questions: [questions[0], { ...questions[1], question: " " }] },
	])("validates the entire batch before opening its first dialog: %j", async (request) => {
		const ctx = context();
		await expect(askQuestions(request as never, ctx)).rejects.toThrow();
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
});

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	ctrlUp: "\x1b[1;5A",
	ctrlDown: "\x1b[1;5B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	enter: "\r",
	esc: "\x1b",
} as const;

const FG_ANSI: Record<string, string> = {
	accent: "\x1b[36m",
	muted: "\x1b[38;5;244m",
	dim: "\x1b[90m",
	borderMuted: "\x1b[38;5;240m",
	text: "\x1b[38;5;252m",
};

function createFakeTheme(): Theme {
	const getFgAnsi = (color: ThemeColor) => FG_ANSI[color] ?? "\x1b[38;5;250m";
	const getBgAnsi = (_color: ThemeBg) => "\x1b[48;5;236m";
	const fg = (color: ThemeColor, text: string) => `${getFgAnsi(color)}${text}\x1b[39m`;
	const bg = (color: ThemeBg, text: string) => `${getBgAnsi(color)}${text}\x1b[49m`;
	const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const italic = (text: string) => `\x1b[3m${text}\x1b[23m`;
	const underline = (text: string) => `\x1b[4m${text}\x1b[24m`;
	const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`;
	const strikethrough = (text: string) => `\x1b[9m${text}\x1b[29m`;
	const style = (text: string, opts: ThemeStyle) => {
		let out = text;
		if (opts.bold) out = bold(out);
		if (typeof opts.fg === "string") out = fg(opts.fg, out);
		if (typeof opts.bg === "string") out = bg(opts.bg, out);
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

type DialogScript = (api: {
	render(width?: number): string[];
	plainLines(width?: number): string[];
	press(key: string): void;
	typeText(text: string): void;
	readonly renderCalls: number;
	readonly component: Component;
}) => void | Promise<void>;

function tuiContext(scripts: DialogScript[], options: { rows?: number; columns?: number; mode?: "tui" | "rpc" } = {}) {
	const rows = options.rows ?? 18;
	const columns = options.columns ?? 72;
	const theme = createFakeTheme();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	const select = vi.fn();
	const input = vi.fn();
	let dialogIndex = 0;
	const custom = vi.fn(async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		const script = scripts[dialogIndex++];
		if (!script) throw new Error(`Unexpected custom dialog #${dialogIndex}`);
		let renderCalls = 0;
		const tui = {
			terminal: { rows, columns },
			requestRender: () => {
				renderCalls++;
			},
		};
		return await new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const done = (result: unknown) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			Promise.resolve(factory(tui as never, theme, keybindings as never, done))
				.then(async (component) => {
					if (settled) return;
					if (isFocusable(component)) component.focused = true;
					await script({
						render: (w = columns) => component.render(w),
						plainLines: (w = columns) => component.render(w).map((line) => stripTerminalSequences(line)),
						press: (key) => component.handleInput?.(key),
						typeText: (text) => {
							for (const ch of text) component.handleInput?.(ch);
						},
						get renderCalls() {
							return renderCalls;
						},
						component,
					});
				})
				.catch(reject);
		});
	});
	return {
		hasUI: true,
		mode: options.mode ?? "tui",
		ui: { select, input, custom } as unknown as ExtensionUIContext,
		select,
		input,
		custom,
		theme,
	};
}

describe("TUI custom question dialog", () => {
	it("renders question in bold accent and multi-paragraph description in non-accent text within terminal.rows, scrolling with PageDown/PageUp", async () => {
		const paragraphs = Array.from(
			{ length: 12 },
			(_, idx) => `Paragraph ${idx + 1}: Detailed layout context for section ${idx + 1} with calm editorial hierarchy and generous spacing.`,
		).join("\n\n");
		const longChoiceDescription =
			"Preserve asymmetric split-hero rhythm across desktop breakpoints while collapsing cleanly to a single column on narrow viewports without clipping.";
		const rows = 16;
		const width = 64;
		const ctx = tuiContext(
			[
				(dialog) => {
					const initialRaw = dialog.render(width);
					expect(initialRaw.length).toBeLessThanOrEqual(rows);
					for (const line of initialRaw) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

					const questionLine = initialRaw.find((line) => stripTerminalSequences(line).includes("Lock the editorial layout?"));
					expect(questionLine).toBeDefined();
					expect(questionLine).toContain(FG_ANSI.accent);
					expect(questionLine).toContain("\x1b[1m");

					const descLine = initialRaw.find((line) => stripTerminalSequences(line).includes("Paragraph 1:"));
					expect(descLine).toBeDefined();
					expect(descLine).toContain(FG_ANSI.text);
					expect(descLine).not.toContain(FG_ANSI.accent);
					expect(descLine).not.toContain("\x1b[1m");

					const initialPlain = initialRaw.map((line) => stripTerminalSequences(line)).join("\n");
					expect(initialPlain).toMatch(/lines 1-\d+ of \d+/);
					expect(initialPlain).not.toContain("Paragraph 12:");
					// Long choice description wraps across lines rather than getting clipped to one line.
					expect(initialPlain).toContain("without clipping.");

					dialog.press(KEYS.pageDown);
					dialog.press(KEYS.pageDown);
					dialog.press(KEYS.pageDown);
					dialog.press(KEYS.pageDown);
					dialog.press(KEYS.pageDown);
					const scrolledRaw = dialog.render(width);
					expect(scrolledRaw.length).toBeLessThanOrEqual(rows);
					const scrolledPlain = scrolledRaw.map((line) => stripTerminalSequences(line)).join("\n");
					expect(scrolledPlain).toContain("Paragraph 12:");
					expect(scrolledPlain).not.toMatch(/lines 1-\d+ of \d+/);

					dialog.press(KEYS.pageUp);
					dialog.press(KEYS.pageUp);
					dialog.press(KEYS.pageUp);
					dialog.press(KEYS.pageUp);
					dialog.press(KEYS.pageUp);
					expect(dialog.plainLines(width).join("\n")).toContain("Paragraph 1:");

					dialog.press(KEYS.enter);
				},
			],
			{ rows, columns: width },
		);

		const result = await askQuestions(
			{
				questions: [
					{
						id: "layout",
						question: "Lock the editorial layout?",
						description: paragraphs,
						choices: [
							{ id: "lock", label: "Lock layout", description: longChoiceDescription },
							{ id: "revise", label: "Revise grid" },
						],
					},
				],
			},
			ctx,
		);

		expect(result).toMatchObject({
			status: "answered",
			answers: [{ id: "layout", choiceId: "lock", value: "Lock layout" }],
			pending: [],
		});
		expect(ctx.custom).toHaveBeenCalledTimes(1);
		expect(ctx.select).not.toHaveBeenCalled();
		expect(ctx.input).not.toHaveBeenCalled();
	});

	it("navigates choices, disambiguates duplicate labels, and supports custom answers including empty string", async () => {
		const ctx = tuiContext([
			(dialog) => {
				const plain = dialog.plainLines().join("\n");
				expect(plain).toContain("Question 1 of 3");
				expect(plain).toContain("Keep (a)");
				expect(plain).toContain("Keep (b)");
				expect(plain).toContain("Drop");
				dialog.press(KEYS.down);
				dialog.press(KEYS.enter);
			},
			(dialog) => {
				expect(dialog.plainLines().join("\n")).toContain("Question 2 of 3");
				// Move down to "Other: type your own answer" and submit an explicit empty string "".
				dialog.press(KEYS.down);
				dialog.press(KEYS.down);
				dialog.press(KEYS.enter);
				const inputRaw = dialog.render().join("\n");
				expect(inputRaw).toContain(CURSOR_MARKER);
				expect(stripTerminalSequences(inputRaw)).toContain("Custom answer");
				dialog.press(KEYS.enter);
			},
			(dialog) => {
				expect(dialog.plainLines().join("\n")).toContain("Question 3 of 3");
				// Free-text mode scrolls description on arrow keys while letting printable j/k into Input.
				dialog.press(KEYS.down);
				dialog.press(KEYS.ctrlUp);
				dialog.typeText("keep calm & bold");
				dialog.press(KEYS.enter);
			},
		]);

		const result = await askQuestions(
			{
				questions: [
					{
						id: "pick",
						question: "Which variant?",
						choices: [
							{ id: "a", label: "Keep" },
							{ id: "b", label: "Keep" },
							{ id: "c", label: "Drop" },
						],
					},
					{
						id: "approve",
						question: "Approve palette?",
						choices: [
							{ id: "warm", label: "Warm paper" },
							{ id: "cool", label: "Cool slate" },
						],
						allowFreeText: true,
					},
					{
						id: "notes",
						question: "Any final direction notes?",
						description: Array.from({ length: 20 }, (_, i) => `Detail line ${i + 1}`).join("\n"),
					},
				],
			},
			ctx,
		);

		expect(result).toEqual({
			status: "answered",
			answers: [
				{ id: "pick", choiceId: "b", value: "Keep" },
				{ id: "approve", value: "" },
				{ id: "notes", value: "keep calm & bold" },
			],
			pending: [],
			message: "Only submitted answers are recorded.",
		});
	});

	it("handles Esc dismissal in both choice and custom-answer modes while preserving earlier answers", async () => {
		const ctx = tuiContext([
			(dialog) => {
				dialog.press(KEYS.enter);
			},
			(dialog) => {
				// Enter "Other: type your own answer", type partial text, then press Esc -> dismissed, not answered!
				dialog.press(KEYS.down);
				dialog.press(KEYS.enter);
				dialog.typeText("draft");
				dialog.press(KEYS.esc);
			},
		]);

		const result = await askQuestions(
			{
				questions: [
					{ id: "first", question: "First?", choices: [{ id: "ok", label: "OK" }] },
					{ id: "second", question: "Second?", choices: [{ id: "skip", label: "Skip" }], allowFreeText: true },
					{ id: "third", question: "Third?" },
				],
			},
			ctx,
		);

		expect(result.status).toBe("dismissed");
		expect(result.answers).toEqual([{ id: "first", choiceId: "ok", value: "OK" }]);
		expect(result.pending.map((q) => q.id)).toEqual(["second", "third"]);
		expect(ctx.custom).toHaveBeenCalledTimes(2);
	});

	it("closes the open TUI dialog on AbortSignal cancellation and preserves partial answers", async () => {
		const controller = new AbortController();
		const ctx = tuiContext([
			(dialog) => {
				dialog.press(KEYS.enter);
			},
			() => {
				controller.abort();
			},
		]);

		const result = await askQuestions({ questions }, ctx, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.answers).toEqual([{ id: "approve", choiceId: "yes", value: "Yes" }]);
		expect(result.pending).toEqual([questions[1]]);
	});

	it("strips terminal escape sequences from displayed text while preserving raw choice values", async () => {
		const rawLabel = "Editorial \x1b[31mInjected\x1b[0m";
		const ctx = tuiContext([
			(dialog) => {
				const rendered = dialog.render(72).join("\n");
				expect(rendered).not.toContain("\x1b[31m");
				expect(rendered).not.toContain("\x1b]52;");
				expect(stripTerminalSequences(rendered)).toContain("Editorial Injected");
				dialog.press(KEYS.enter);
			},
		]);

		const result = await askQuestions(
			{
				questions: [
					{
						id: "safe",
						question: "Pick \x1b]52;c;Y2xpcA==\x07style?",
						description: "Safe \x1b[31mdescription\x1b[0m body",
						choices: [{ id: "ed", label: rawLabel, description: "Clean \x1b[7mdesc\x1b[0m" }],
					},
				],
			},
			ctx,
		);

		expect(result.status).toBe("answered");
		expect(result.answers).toEqual([{ id: "safe", choiceId: "ed", value: rawLabel }]);
	});

	it("windows 11 choices with long descriptions without overflowing terminal.rows", async () => {
		const rows = 14;
		const width = 60;
		const choices = Array.from({ length: 10 }, (_, idx) => ({
			id: `opt-${idx + 1}`,
			label: `Option ${idx + 1}`,
			description: `Detailed explanation for option ${idx + 1} covering typography, spacing, hierarchy, and responsive grid trade-offs.`,
		}));
		const ctx = tuiContext(
			[
				(dialog) => {
					for (let step = 0; step < 10; step++) {
						const rendered = dialog.render(width);
						expect(rendered.length).toBeLessThanOrEqual(rows);
						for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
						dialog.press(KEYS.down);
					}
					const atCustom = dialog.plainLines(width).join("\n");
					expect(atCustom).toContain("Other: type your own answer");
					dialog.press(KEYS.up);
					expect(dialog.plainLines(width).join("\n")).toContain("Option 10");
					dialog.press(KEYS.enter);
				},
			],
			{ rows, columns: width },
		);

		const result = await askQuestions(
			{
				questions: [
					{
						id: "many",
						question: "Choose a comprehensive visual direction?",
						description: Array.from({ length: 8 }, (_, idx) => `Context paragraph ${idx + 1} with background notes.`).join("\n\n"),
						choices,
						allowFreeText: true,
					},
				],
			},
			ctx,
		);

		expect(result.status).toBe("answered");
		expect(result.answers).toEqual([{ id: "many", choiceId: "opt-10", value: "Option 10" }]);
	});

	it("keeps using ui.select and ui.input in rpc mode even when ui.custom is present", async () => {
		const ctx = tuiContext([], { mode: "rpc" });
		ctx.select.mockResolvedValue("Yes");
		ctx.input.mockResolvedValue("Clear visitor purpose");

		const result = await askQuestions({ questions }, ctx);
		expect(result).toMatchObject({
			status: "answered",
			answers: [
				{ id: "approve", choiceId: "yes", value: "Yes" },
				{ id: "purpose", value: "Clear visitor purpose" },
			],
			pending: [],
		});
		expect(ctx.custom).not.toHaveBeenCalled();
		expect(ctx.select).toHaveBeenCalledTimes(1);
		expect(ctx.input).toHaveBeenCalledTimes(1);
	});
});
