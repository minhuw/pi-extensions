import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PROCESS_STATUS_KEY, summarizeProcesses } from "../processes.ts";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import statuslineFooter, {
	alignRow,
	chipInk,
	contrastRatio,
	displayServiceTier,
	extractServiceTier,
	formatPath,
	gradientBar,
	hasNerdFonts,
	parseGitAheadBehind,
	parseGitShortstat,
	parseGitStatus,
	hexFg,
	legibleOn,
	modelBrand,
	rainbow,
	renderModelMark,
	renderStatus,
	renderThinking,
	shortenPath,
	statusHue,
	statusPalette,
	statusTone,
} from "../index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

beforeEach(() => {
	vi.mocked(execFile).mockReset();
});

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type FooterComponent = {
	dispose?: () => void;
	render: (width: number) => string[];
};

type HarnessModel = { id: string; provider?: string; api?: string; reasoning?: boolean; magpieServiceTiers?: string[]; magpiePricing?: "estimate" | "unavailable"; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } };

type HarnessOptions = {
	model?: HarnessModel | null;
	registryModels?: HarnessModel[];
	thinkingLevel?: string;
	contextUsage?: { percent?: number; tokens?: number; contextWindow: number } | null;
	branch?: any[];
	entries?: any[];
	cwd?: string;
	gitBranch?: string | null;
	extensionStatuses?: string[];
	keyedExtensionStatuses?: Record<string, string>;
	isIdle?: boolean;
	hasPendingMessages?: boolean;
	events?: ExtensionAPI["events"];
	theme?: { fg: (token: string, text: string) => string; bg?: (token: string, text: string) => string; bold: (text: string) => string };
};

function createHarness(sessionId: string, mode: "tui" | "print", options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const events = options.events ?? createEventBus();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const notifications: string[] = [];
	const entries = options.entries ?? [];
	const requestRender = vi.fn();
	let footer: FooterComponent | undefined;
	let footerInstallCount = 0;
	let footerDisposeCount = 0;
	const branchSubscribe = vi.fn();
	const branchUnsubscribe = vi.fn();
	const extensionStatuses = new Map((options.extensionStatuses ?? ["READY"]).map((status) => [status, status]));
	for (const [key, status] of Object.entries(options.keyedExtensionStatuses ?? {})) extensionStatuses.set(key, status);

	const tui = { requestRender };
	const footerData = {
		onBranchChange: vi.fn(() => {
			branchSubscribe();
			return () => branchUnsubscribe();
		}),
		getGitBranch: () => options.gitBranch ?? "main",
		getExtensionStatuses: () => extensionStatuses,
	};
	const theme = options.theme ?? {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	};

	const ui = {
		setStatus: vi.fn((key: string, status?: string) => {
			if (status) extensionStatuses.set(key, status);
			else extensionStatuses.delete(key);
		}),
		setFooter: vi.fn((factory: unknown) => {
			if (footer) {
				footer.dispose?.();
				footerDisposeCount++;
			}
			footer = typeof factory === "function"
				? (factory as (tui: unknown, theme: unknown, footerData: unknown) => FooterComponent)(
						tui,
						theme,
						footerData,
					)
				: undefined;
			if (footer) footerInstallCount++;
		}),
		notify: vi.fn((message: string) => notifications.push(message)),
	};

	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: options.cwd ?? "/tmp/project",
		model: options.model === null
			? undefined
			: options.model ?? { id: "k3", provider: "moonshot", reasoning: true },
		thinkingLevel: options.thinkingLevel ?? "high",
		isIdle: () => options.isIdle ?? true,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
		getContextUsage: () => options.contextUsage === null
			? undefined
			: options.contextUsage ?? { percent: 42.5, tokens: 42_500, contextWindow: 100_000 },
		modelRegistry: {
			getAll: () => options.registryModels ?? (ctx.model ? [ctx.model] : []),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => options.branch?.at(-1)?.id ?? "leaf",
			getBranch: () => options.branch ?? [],
			getEntries: vi.fn(() => entries),
		},
		ui,
	} as unknown as ExtensionContext;

	const pi = {
		events,
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		}),
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		events,
		entries,
		notifications,
		requestRender,
		setStatus: (key: string, status?: string) => status ? extensionStatuses.set(key, status) : extensionStatuses.delete(key),
		getFooter: () => footer,
		disposeFooter() {
			if (footer) {
				footer.dispose?.();
				footerDisposeCount++;
				footer = undefined;
			}
		},
		footerInstallCount: () => footerInstallCount,
		footerDisposeCount: () => footerDisposeCount,
		branchSubscribe,
		branchUnsubscribe,
		async emit(name: string, event: any) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		async runCommand(name: string, args: string) {
			const command = commands.get(name);
			if (!command) throw new Error(`Command not registered: ${name}`);
			await command.handler(args, ctx);
		},
	};
}

function assistantEnd(output: number) {
	return {
		message: {
			role: "assistant",
			usage: { output },
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("statusline footer visual language", () => {
	it("right-aligns secondary facts and stays within width", () => {
		const row = alignRow("k3  HIGH", "8.2% / 1.05M", 40);
		expect(visibleWidth(row)).toBeLessThanOrEqual(40);
		expect(row).toContain("k3  HIGH");
		expect(row).toContain("8.2% / 1.05M");
		expect(row.indexOf("k3")).toBeLessThan(row.indexOf("8.2%"));
		expect(row.trimEnd().endsWith("8.2% / 1.05M")).toBe(true);
	});

	it("builds a fixed-width gradient bar", () => {
		expect(visibleWidth(gradientBar(0, 18))).toBe(18);
		expect(visibleWidth(gradientBar(50, 18))).toBe(18);
		expect(visibleWidth(gradientBar(100, 10))).toBe(10);
		expect(gradientBar(40, 8)).toContain("▉");
	});

	it("washes max thinking labels across a rainbow", () => {
		const theme = { fg: (_token: string, text: string) => text } as unknown as Parameters<typeof renderThinking>[0];
		expect(renderThinking(theme, "max")).toBe(rainbow("MAX"));
		expect(renderThinking(theme, "xhigh")).toBe(rainbow("XHIGH"));
		expect(renderThinking(theme, "medium")).toBe("MEDIUM");
		const painted = rainbow("MAX");
		expect(painted).toContain("\x1b[38;2;");
		expect(painted.endsWith("\x1b[0m")).toBe(true);
		expect(visibleWidth(painted)).toBe(3);
	});

	it("gives statuses an identity hue and marks problems in warning, never red", () => {
		const theme = { fg: (token: string, text: string) => `<${token}>${text}`, bold: (text: string) => `*${text}*` } as unknown as Parameters<typeof renderStatus>[0];
		const herder = statusHue(theme, "herder");
		expect(renderStatus(theme, "herder: T2 integrate · 3/5 tasks", "herder")).toBe(`<${herder}>herder: T2 integrate<dim> · <muted>3/5 tasks`);
		expect(renderStatus(theme, "bg 2 running · 1 failed", PROCESS_STATUS_KEY))
			.toBe(`<${statusHue(theme, PROCESS_STATUS_KEY)}>bg 2 running<dim> · <warning>*1 failed*`);
		expect(renderStatus(theme, "↻ build · paused", "loop")).toBe(`<${statusHue(theme, "loop")}>↻ build<dim> · <warning>paused`);
		expect(renderStatus(theme, "\x1b[32mpainted\x1b[0m", "x")).toBe("\x1b[32mpainted\x1b[0m");
		expect(new Set(["autoresearch", "herder", "loop", PROCESS_STATUS_KEY].map(key => statusHue(theme, key))).size).toBe(4);
		expect(statusHue(theme, "custom")).toBe(statusHue(theme, "custom"));
		// Appended to the known keys, so the slots before it keep their colors.
		const palette = statusPalette(theme);
		expect(statusHue(theme, "impeccable-live")).toBe(palette[5 % palette.length]);
		expect(statusHue(theme, "language")).toBe(palette[6 % palette.length]);
		expect(statusHue(theme, "spokesman")).toBe(palette[7 % palette.length]);
		for (const segment of ["1 failed", "1 stuck", "state error", "herder: verified not_met", "verified blocked"]) {
			expect(statusTone(segment)).toBe("problem");
		}
		for (const segment of ["paused", "awaiting approval", "1 for you", "1 stopping", "1 killed"]) {
			expect(statusTone(segment)).toBe("attention");
		}
		for (const segment of ["↻ fix-errors", "herder: verified met", "next 4m", "waiting", "subagents: on", "2 working"]) {
			expect(statusTone(segment)).toBe("calm");
		}
	});

	it("leaves red and warning-like theme hues out of the status palette", () => {
		const colors: Record<string, string> = {
			error: "#FF5252", warning: "#FFB300", mdLink: "#00897B", syntaxVariable: "#7E57C2", success: "#00C853",
			syntaxType: "#E91E63", syntaxFunction: "#00897B", syntaxString: "#FF6F00", mdCode: "#B8B0C0",
			thinkingLow: "#1DE9B6", border: "#AD1457", bashMode: "#2196F3",
		};
		const theme = { fg: (token: string, text: string) => `${hexFg(colors[token] ?? "#808080", "")}${text}` } as unknown as Parameters<typeof statusPalette>[0];
		expect(statusPalette(theme)).toEqual(["mdLink", "syntaxVariable", "success", "bashMode"]);
	});

	it("matches model brands by id before provider and tints the mark", () => {
		expect(modelBrand("claude-opus-5-5", "google-vertex")?.plain).toBe("✻");
		expect(modelBrand("codex/gpt-6.1-sol", "magpie")?.plain).toBe("⊛");
		expect(modelBrand("o3-mini", "openai")?.plain).toBe("⊛");
		expect(modelBrand("gemini-3-pro", "google")?.plain).toBe("✦");
		expect(modelBrand("llama-4", "google-vertex")?.plain).toBe("∞");
		expect(modelBrand("k3", "moonshot")?.plain).toBe("☾");
		expect(modelBrand("deepseek-v4", "openrouter")?.plain).toBe("≋");
		expect(modelBrand("qwen3-coder", "")?.plain).toBe("⬡");
		expect(modelBrand("mystery-1", "local")).toBeUndefined();
		const theme = { fg: (token: string, text: string) => `<${token}>${text}`, bold: (text: string) => text } as unknown as Parameters<typeof renderModelMark>[0];
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		expect(renderModelMark(theme, "claude-opus-5-5")).toBe(`${hexFg("#D97757", "✻")} `);
		expect(renderModelMark(theme, "grok-5")).toBe("<text>⨯ ");
		expect(renderModelMark(theme, "mystery-1")).toBe("");
		vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
		expect(renderModelMark(theme, "claude-opus-5-5")).toBe(`${hexFg("#D97757", "\u{EC82}")} `);
		expect(renderModelMark(theme, "gpt-6")).toBe(`${hexFg("#10A37F", "\u{EC81}")} `);
		vi.unstubAllEnvs();
	});

	it("abbreviates the home directory with a portable tilde", () => {
		expect(formatPath("/Users/ada/code/pi", "/Users/ada")).toBe("~/code/pi");
		expect(formatPath("/Users/ada", "/Users/ada")).toBe("~");
		expect(formatPath("/tmp/work", "/Users/ada")).toBe("/tmp/work");
	});

	it("parses git shortstat and upstream ahead/behind", () => {
		expect(parseGitShortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n")).toEqual({
			files: 3,
			adds: 12,
			dels: 4,
		});
		expect(parseGitAheadBehind("2\t5\n")).toEqual({ behind: 2, ahead: 5 });
		expect(parseGitAheadBehind("")).toEqual({ ahead: 0, behind: 0 });
	});

	it("parses authoritative git status output", () => {
		expect(parseGitStatus("")).toBe("clean");
		expect(parseGitStatus(" M src/example.ts\n")).toBe("dirty");
		expect(parseGitStatus("?? untracked.txt\n")).toBe("dirty");
	});
	it("shows only non-standard service tiers", () => {
		expect(extractServiceTier({ service_tier: "priority" })).toBe("priority");
		expect(extractServiceTier({ serviceTier: "flex" })).toBe("flex");
		expect(displayServiceTier("priority")).toBe("FAST");
		expect(displayServiceTier("flex")).toBe("FLEX");
		expect(displayServiceTier("standard")).toBeUndefined();
		expect(displayServiceTier("default")).toBeUndefined();
	});

	it("assumes Nerd Fonts unless STATUSLINE_NERD_FONTS=0 opts out", () => {
		try {
			vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
			vi.stubEnv("STATUSLINE_NERD_FONTS", undefined);
			vi.stubEnv("FOOTER_NERD_FONTS", undefined);
			expect(hasNerdFonts()).toBe(true);
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			expect(hasNerdFonts()).toBe(false);
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			expect(hasNerdFonts()).toBe(true);
			vi.stubEnv("STATUSLINE_NERD_FONTS", undefined);
			vi.stubEnv("FOOTER_NERD_FONTS", "0");
			expect(hasNerdFonts()).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("statusline footer responsive identity and icons", () => {
	it.each(["full", "compact"])("preserves model and percent in narrow %s mode", async (mode) => {
		for (const nerdFonts of ["0", "1"]) {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			const harness = createHarness(`responsive-${mode}-${nerdFonts}`, "tui", {
				model: { id: "gpt-5.4", provider: "openai", reasoning: true },
			});
			try {
				statuslineFooter(harness.pi);
				await harness.emit("session_start", { reason: "startup" });
				await harness.runCommand("footer", mode);
				for (const width of [0, 1, 2, 3, 12, 24, 40, 60, 80, 120]) {
					const lines = harness.getFooter()!.render(width);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					if (width >= 24) {
						expect(lines[0]).toContain("gpt-5.4");
						expect(lines[0]).toContain("42.5%");
					}
				}
				const narrow = harness.getFooter()!.render(40)[0]!;
				expect(narrow).not.toContain("openai");
				expect(narrow).not.toContain("100k");
				expect([...narrow].filter((char) => char === "▉").length).toBeLessThan(mode === "full" ? 18 : 10);
			} finally {
				harness.disposeFooter();
				await harness.emit("session_shutdown", { reason: "quit" });
				vi.unstubAllEnvs();
			}
		}
	});

	it("bounds a long Unicode model label while keeping its prefix and context percent", async () => {
		const harness = createHarness("responsive-unicode-model", "tui", {
			model: { id: "模型模型模型模型模型模型模型模型", provider: "provider", reasoning: true },
			thinkingLevel: "xhigh",
		});
		try {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			for (const mode of ["full", "compact"]) {
				await harness.runCommand("footer", mode);
				const lines = harness.getFooter()!.render(24);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
				expect(lines[0]).toContain("模型");
				expect(lines[0]).toContain("42.5%");
			}
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
		}
	});

	it("renders supplementary-plane Nerd Font icons without stray suffix characters", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
		const harness = createHarness("nerd-font-codepoints", "tui", {
			branch: [{ type: "message", message: {
				role: "assistant",
				usage: { input: 1, output: 2, cacheRead: 3, cost: { total: 0.01 } },
				content: [{ type: "toolCall", name: "read", arguments: { path: "example.ts" } }],
			} }],
		});
		try {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			const rendered = harness.getFooter()!.render(240).join("\n");
			for (const codepoint of [0xF0615, 0xF0954, 0xF0368, 0xF005E, 0xF0046, 0xF140B,
				0xF01C1, 0xF051B, 0xF04C5, 0xF05B7, 0xF0133, 0xF062C, 0xF0224, 0xF0770]) {
				expect(rendered).toContain(String.fromCodePoint(codepoint));
			}
			expect(rendered).not.toMatch(/[\uF000-\uF8FF]/u);
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			vi.unstubAllEnvs();
		}
	});
});

describe("statusline footer rendering", () => {
	const branch = [
		{
			type: "message",
			message: { role: "user", timestamp: 1_000 },
		},
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 1_000,
					output: 250,
					cacheRead: 500,
					reasoning: 100,
					cost: { total: 0.75 },
				},
				content: [{ type: "toolCall", arguments: { path: "src/example.ts" } }],
			},
		},
		{ type: "message", message: {
			role: "toolResult",
			isError: true,
			usage: {
				input: 200,
				output: 50,
				cacheRead: 100,
				reasoning: 25,
				cost: { total: 0.10 },
			},
		} },
		{
			type: "compaction",
			usage: {
				input: 300,
				output: 75,
				cacheRead: 150,
				reasoning: 30,
				cost: { total: 0.20 },
			},
		},
		{
			type: "branch_summary",
			usage: {
				input: 400,
				output: 100,
				cacheRead: 200,
				reasoning: 40,
				cost: { total: 0.30 },
			},
		},
	];

	it("renders width-bounded full-mode lines with representative facts", async () => {
		const harness = createHarness("render-full-session", "tui", { branch, cwd: "/tmp/project" });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const lines = harness.getFooter()!.render(100);
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(lines[0]).toContain("k3");
		expect(lines[0]).toContain("HIGH");
		expect(lines[0]).toContain("42.5%");
		// The telemetry row hangs from the bar on the rail.
		expect(lines[1]!.startsWith(" ├ ")).toBe(true);
		expect(lines[1]).toContain("$1.35");
		expect(lines[1]).not.toContain("think");
		// With room for every group, the reasoning count, the first to give way, returns.
		const wide = harness.getFooter()!.render(200)[1]!;
		for (const fact of ["$1.35", "1.9k", "475", "950", "195 think"]) expect(wide).toContain(fact);
		expect(lines[2]).toContain("main");
		expect(lines[2]).toContain("1 touched");
		expect(lines[2]).not.toContain("READY");
		expect(lines[3]).toContain("READY");
		harness.getFooter()?.dispose?.();
	});


	it("renders clean, dirty, pending, and unavailable Git states", async () => {
		let statusOutput = "";
		let statusError = false;
		let defer = true;
		const pendingCallbacks: Array<() => void> = [];
		vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
			const complete = () => {
				const cb = callback as (error: Error | null, stdout: string) => void;
				if (args?.[1] === "status") cb(statusError ? new Error("git unavailable") : null, statusOutput);
				else if (args?.[0] === "diff") cb(null, "");
				else cb(new Error("no upstream"), "");
			};
			if (defer) pendingCallbacks.push(complete);
			else complete();
			return {} as ReturnType<typeof execFile>;
		});

		const pending = createHarness("git-pending", "tui");
		statuslineFooter(pending.pi);
		await pending.emit("session_start", { type: "session_start", reason: "startup" });
		expect(pending.getFooter()!.render(120)[2]).toContain("git …");
		expect(execFile).toHaveBeenCalledWith(
			"git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"],
			expect.objectContaining({ cwd: pending.ctx.cwd }), expect.any(Function),
		);
		defer = false;
		for (const complete of pendingCallbacks) complete();
		pending.getFooter()?.dispose?.();

		const clean = createHarness("git-clean", "tui");
		statuslineFooter(clean.pi);
		await clean.emit("session_start", { type: "session_start", reason: "startup" });
		expect(clean.getFooter()!.render(120)[2]).toContain("clean");
		clean.getFooter()?.dispose?.();

		statusOutput = "?? untracked.txt\n";
		const dirty = createHarness("git-dirty", "tui");
		statuslineFooter(dirty.pi);
		await dirty.emit("session_start", { type: "session_start", reason: "startup" });
		const dirtyLine = dirty.getFooter()!.render(120)[2]!;
		expect(dirtyLine).toContain("dirty");
		expect(dirtyLine).not.toContain("clean");
		dirty.getFooter()?.dispose?.();

		statusError = true;
		const unavailable = createHarness("git-unavailable", "tui");
		statuslineFooter(unavailable.pi);
		await unavailable.emit("session_start", { type: "session_start", reason: "startup" });
		const unavailableLine = unavailable.getFooter()!.render(120)[2]!;
		expect(unavailableLine).toContain("git ?");
		expect(unavailableLine).not.toContain("clean");
		unavailable.getFooter()?.dispose?.();
	});

	it("counts optional usage once and only on the active branch", async () => {
		const activeBranch = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 9, reasoning: 4, cost: { total: 0.01 } },
				},
			},
			{ type: "compaction", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 90, reasoning: 40, cost: { total: 0.10 } } },
			{ type: "branch_summary", usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 900, reasoning: 400, cost: { total: 1 } } },
			{ type: "message", message: { role: "toolResult", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 9, reasoning: 4, cost: { total: 0.01 } } } },
		];
		const harness = createHarness("usage-branch-boundary", "tui", {
			branch: activeBranch,
			entries: [{ type: "message", message: {
				role: "assistant",
				usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cost: { total: 100 } },
			} }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const lines = harness.getFooter()!.render(240);
		const totals = lines[1]!;
		expect(lines[1]).toContain("$1.12");
		expect(totals).toContain("112");
		expect(totals).toContain("224");
		expect(totals).toContain("336");
		expect(totals).toContain("448 think");
		expect(totals).toContain("23%");
		expect(totals).not.toContain("1M");
		expect(harness.ctx.sessionManager.getEntries).not.toHaveBeenCalled();
		harness.getFooter()?.dispose?.();
	});

	it.each([
		[9_000, "9%"],
		[undefined, "90%"],
	])("includes cache writes (%s) in the cache-hit denominator", async (cacheWrite, expected) => {
		const harness = createHarness(`cache-writes-${cacheWrite}`, "tui", {
			branch: [{ type: "message", message: {
				role: "assistant",
				usage: { input: 100, output: 20, cacheRead: 900, cacheWrite, cost: { total: 0 } },
			} }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const totals = harness.getFooter()!.render(240)[1]!;
		expect(totals).toContain(expected);
		if (cacheWrite) expect(totals).not.toContain("90%");
		harness.disposeFooter();
	});

	it("tolerates missing usage on every optional carrier", async () => {
		const harness = createHarness("usage-missing", "tui", {
			branch: [
				{ type: "message", message: { role: "toolResult", isError: true } },
				{ type: "compaction" },
				{ type: "branch_summary" },
			],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const lines = harness.getFooter()!.render(240);
		expect(lines[1]).toContain("$0.000");
		expect(lines[1]).not.toContain("think");
		harness.getFooter()?.dispose?.();
	});

	it("renders compact mode and restores the full layout", async () => {
		const harness = createHarness("render-mode-session", "tui", { branch });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", "compact");

		const compact = harness.getFooter()!.render(80);
		expect(compact).toHaveLength(1);
		expect(visibleWidth(compact[0]!)).toBeLessThanOrEqual(80);
		expect(compact[0]).toContain("k3");
		expect(compact[0]).toContain("42.5%");
		expect(compact[0]).toContain("$1.35");

		await harness.runCommand("footer", "full");
		const full = harness.getFooter()!.render(80);
		expect(full).toHaveLength(4);
		for (const line of full) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		harness.getFooter()?.dispose?.();
	});

	it("shows changing loop status in compact mode only while identity and percent fit", async () => {
		const harness = createHarness("compact-loop-status", "tui", {
			keyedExtensionStatuses: { loop: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			for (const width of [120, 60, 38, 30, 24, 1]) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 38) expect(line).toContain("↻ build · next 4m");
				else expect(line).not.toContain("↻ build");
				if (width >= 24) {
					expect(line).toContain("k3");
					expect(line).toContain("42.5%");
				}
				expect(line).not.toContain("SYNC");
			}
			harness.setStatus("loop", "↻ paused");
			expect(harness.getFooter()!.render(60)[0]).toContain("↻ paused");
			expect(harness.getFooter()!.render(60)[0]).not.toContain("↻ build");
			harness.setStatus("loop");
			expect(harness.getFooter()!.render(120)[0]).not.toContain("↻ paused");
			expect(harness.getFooter()!.render(120)[0]).toContain("42.5%");
		} finally {
			harness.disposeFooter();
		}
	});

	it("fits wide Unicode loop status without clipping model or context", async () => {
		const harness = createHarness("compact-unicode-loop", "tui", {
			model: { id: "模型模型", reasoning: true },
			keyedExtensionStatuses: { loop: "↻ 構築 · 次 4m" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			for (const width of [28, 32, 36, 60]) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).toContain("模型模型");
				expect(line).toContain("42.5%");
				if (width === 28) expect(line).not.toContain("構築");
				if (width === 60) expect(line).toContain("↻ 構築 · 次 4m");
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it("gives loop and generic statuses their own row beside a long cwd in full mode", async () => {
		const harness = createHarness("full-loop-status", "tui", {
			cwd: `/tmp/${"深い階層/".repeat(30)}project`,
			keyedExtensionStatuses: { loop: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			for (const width of [55, 80, 120]) {
				const lines = harness.getFooter()!.render(width);
				expect(lines).toHaveLength(4);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(lines[2]).toContain("main");
				expect(lines[2]).toContain("/…/");
				expect(lines[2]).toContain("project");
				expect(lines[2]).not.toContain("↻");
				expect(lines[3]).toContain("↻ build · next 4m");
				expect(lines[3]!.split("↻ build · next 4m")).toHaveLength(2);
				expect(lines[3]).toContain("READY");
				expect(lines[3]).toContain("SYNC");
			}
			harness.setStatus("loop", "↻ wait · next 4m");
			expect(harness.getFooter()!.render(80)[3]).toContain("↻ wait · next 4m");
			for (const key of ["loop", "other", "READY"]) harness.setStatus(key);
			expect(harness.getFooter()!.render(80)).toHaveLength(3);
		} finally {
			harness.disposeFooter();
		}
	});

	it("orders full-mode statuses research, Herder, loop, then the rest", async () => {
		const harness = createHarness("full-herder-status", "tui", {
			keyedExtensionStatuses: { other: "SYNC", loop: "loop build", herder: "herder: T2 integrate · 3/5 tasks", autoresearch: "research 2/5" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const line = harness.getFooter()!.render(200)[3]!;
			expect(line.split("herder: T2 integrate · 3/5 tasks")).toHaveLength(2);
			const order = ["research 2/5", "herder: T2", "loop build", "SYNC"].map(text => line.indexOf(text));
			expect(order.every(index => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps Herder and the branch visible beside a long cwd in full mode", async () => {
		const harness = createHarness("full-herder-cwd", "tui", {
			cwd: `/tmp/${"深い階層/".repeat(30)}project`,
			keyedExtensionStatuses: { herder: "herder: T2 integrate · 3/5 tasks" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			for (const width of [60, 80, 120]) {
				const lines = harness.getFooter()!.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(lines[3]).toContain("herder: T2 integrate · 3/5 tasks");
				expect(lines[2]).toContain("main");
				expect(lines[2]).toContain("/…/");
				expect(lines[2]).toContain("project");
			}
			harness.setStatus("herder");
			expect(harness.getFooter()!.render(120)[3]).not.toContain("herder:");
		} finally {
			harness.disposeFooter();
		}
	});

	it("ranks Herder below research and above loop in compact mode", async () => {
		const harness = createHarness("compact-herder-status", "tui", {
			keyedExtensionStatuses: { loop: "loop build", herder: "herder: T2 integrate · 3/5 tasks" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			let line = harness.getFooter()!.render(160)[0]!;
			expect(line).toContain("herder: T2 integrate · 3/5 tasks");
			expect(line).not.toContain("loop build");
			harness.setStatus("autoresearch", "research 2/5");
			line = harness.getFooter()!.render(160)[0]!;
			expect(line).toContain("research 2/5");
			expect(line).not.toContain("herder:");
			harness.setStatus("autoresearch");
			harness.setStatus("herder");
			line = harness.getFooter()!.render(160)[0]!;
			expect(line).toContain("loop build");
			expect(line).not.toContain("herder:");
			for (const width of [24, 30]) {
				harness.setStatus("herder", "herder: T2 integrate · 3/5 tasks");
				const narrow = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(narrow)).toBeLessThanOrEqual(width);
				expect(narrow).toContain("k3");
				expect(narrow).toContain("42.5%");
				expect(narrow).not.toContain("herder:");
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("shows the language in the %s bar and never on a status row", async (mode) => {
		const harness = createHarness(`language-bar-${mode}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: { language: "English" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		const rows = mode === "full" ? 3 : 1;
		try {
			const lines = harness.getFooter()!.render(120);
			expect(lines).toHaveLength(rows);
			expect(lines[0]).toContain("\u{F05CA} English");
			for (const line of lines.slice(1)) expect(line).not.toContain("English");
			harness.setStatus("language", "中文");
			expect(harness.getFooter()!.render(120)[0]).toContain("\u{F05CA} 中文");
			expect(harness.getFooter()!.render(120)[0]).not.toContain("English");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			harness.setStatus("language", "English");
			expect(harness.getFooter()!.render(120)[0]).toContain("English");
			expect(harness.getFooter()!.render(120)[0]).not.toContain("\u{F05CA}");
			harness.setStatus("language");
			expect(harness.getFooter()!.render(120)).toHaveLength(rows);
			expect(harness.getFooter()!.render(120)[0]).not.toContain("English");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("keeps the other statuses on their row beside the language in full mode", async () => {
		const harness = createHarness("language-beside-row", "tui", {
			keyedExtensionStatuses: { language: "English", loop: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const lines = harness.getFooter()!.render(120);
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain("English");
			for (const status of ["↻ build · next 4m", "READY", "SYNC"]) {
				expect(lines[0]).not.toContain(status);
				expect(lines[3]).toContain(status);
			}
			expect(lines[3]).not.toContain("English");
		} finally {
			harness.disposeFooter();
		}
	});

	it("gives the language up before the workflow and process statuses in compact mode", async () => {
		const statuses = { herder: "herder: T2 integrate", [PROCESS_STATUS_KEY]: "bg 1" };
		const start = async (id: string, keyedExtensionStatuses: Record<string, string>) => {
			const harness = createHarness(id, "tui", { extensionStatuses: [] });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", "compact");
			// Set after startup: the footer's process watcher publishes its own key then.
			for (const [key, status] of Object.entries(keyedExtensionStatuses)) harness.setStatus(key, status);
			return harness;
		};
		const harness = await start("language-order", { ...statuses, language: "English" });
		const baseline = await start("language-order-baseline", statuses);
		try {
			const narrowest = { language: Infinity, workflow: Infinity };
			for (let width = 160; width >= 1; width--) {
				const line = harness.getFooter()!.render(width)[0]!;
				if (line.includes("English")) {
					narrowest.language = width;
					expect(line, `${width}`).toContain("herder: T2 integrate  bg 1");
				} else {
					expect(line, `${width}`).toBe(baseline.getFooter()!.render(width)[0]);
				}
				if (line.includes("herder: T2 integrate")) narrowest.workflow = width;
			}
			expect(narrowest.language).toBeGreaterThan(narrowest.workflow);
			expect(narrowest.workflow).toBeLessThan(160);
		} finally {
			harness.disposeFooter();
			baseline.disposeFooter();
		}
	});

	it("keeps the provider fallback in full mode, with the language outlasting the provider", async () => {
		const start = async (id: string, keyedExtensionStatuses: Record<string, string>) => {
			const harness = createHarness(id, "tui", { extensionStatuses: [], keyedExtensionStatuses });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			return harness;
		};
		const harness = await start("language-provider", { language: "English" });
		const baseline = await start("language-provider-baseline", {});
		const bar = (footer: typeof harness, width: number) => footer.getFooter()!.render(width)[0]!;
		try {
			const seen = { both: false, languageOnly: false, providerOnly: false, neither: false };
			for (let width = 160; width >= 24; width--) {
				const line = bar(harness, width);
				const language = line.includes("English");
				const provider = line.includes("(moonshot)");
				if (language && provider) seen.both = true;
				else if (language) seen.languageOnly = true;
				else if (provider) seen.providerOnly = true;
				else seen.neither = true;
				if (!language) expect(line, `${width}`).toBe(bar(baseline, width));
			}
			expect(seen).toEqual({ both: true, languageOnly: true, providerOnly: false, neither: true });
		} finally {
			harness.disposeFooter();
			baseline.disposeFooter();
		}
	});

	it.each(["full", "compact"])("shows the spokesman in the %s bar to the right of language and never on a status row", async (mode) => {
		const harness = createHarness(`spokesman-bar-${mode}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: { language: "English", spokesman: "gpt-4o-mini" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		const rows = mode === "full" ? 3 : 1;
		try {
			const lines = harness.getFooter()!.render(160);
			expect(lines).toHaveLength(rows);
			expect(lines[0]).toContain("\u{F05CA} English");
			expect(lines[0]).toContain("\u{F05CB} gpt-4o-mini");
			expect(lines[0]!.indexOf("English")).toBeLessThan(lines[0]!.indexOf("gpt-4o-mini"));
			for (const line of lines.slice(1)) expect(line).not.toContain("gpt-4o-mini");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			expect(harness.getFooter()!.render(160)[0]).toContain("gpt-4o-mini");
			expect(harness.getFooter()!.render(160)[0]).not.toContain("\u{F05CB}");
			harness.setStatus("spokesman");
			expect(harness.getFooter()!.render(160)).toHaveLength(rows);
			expect(harness.getFooter()!.render(160)[0]).not.toContain("gpt-4o-mini");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("sheds spokesman whole before language as width narrows, and both outlast the provider in full mode", async () => {
		const start = async (id: string, mode: "full" | "compact", keyedExtensionStatuses: Record<string, string>) => {
			const harness = createHarness(id, "tui", { extensionStatuses: [], keyedExtensionStatuses });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			return harness;
		};
		const fullHarness = await start("spokesman-full-order", "full", { language: "English", spokesman: "gpt-4o-mini" });
		const fullLangOnly = await start("spokesman-full-lang", "full", { language: "English" });
		const compactHarness = await start("spokesman-compact-order", "compact", {
			herder: "herder: T2",
			language: "English",
			spokesman: "gpt-4o-mini",
		});
		try {
			const seenFull = { all: false, bothNoProvider: false, langOnly: false, providerWithoutSpokesman: false };
			for (let width = 160; width >= 24; width--) {
				const line = fullHarness.getFooter()!.render(width)[0]!;
				const hasLang = line.includes("English");
				const hasSpokesman = line.includes("gpt-4o-mini");
				const hasProvider = line.includes("(moonshot)");
				if (hasSpokesman) expect(hasLang, `${width}`).toBe(true);
				if (hasLang && hasSpokesman && hasProvider) seenFull.all = true;
				if (hasLang && hasSpokesman && !hasProvider) seenFull.bothNoProvider = true;
				if (hasLang && !hasSpokesman) {
					seenFull.langOnly = true;
					expect(line, `${width}`).toBe(fullLangOnly.getFooter()!.render(width)[0]);
				}
				if (hasProvider && !hasSpokesman) seenFull.providerWithoutSpokesman = true;
			}
			expect(seenFull).toEqual({
				all: true,
				bothNoProvider: true,
				langOnly: true,
				providerWithoutSpokesman: false,
			});

			const narrowestCompact = { spokesman: Infinity, language: Infinity, workflow: Infinity };
			for (let width = 160; width >= 24; width--) {
				const line = compactHarness.getFooter()!.render(width)[0]!;
				if (line.includes("gpt-4o-mini")) narrowestCompact.spokesman = width;
				if (line.includes("English")) narrowestCompact.language = width;
				if (line.includes("herder: T2")) narrowestCompact.workflow = width;
			}
			expect(narrowestCompact.spokesman).toBeGreaterThan(narrowestCompact.language);
			expect(narrowestCompact.language).toBeGreaterThan(narrowestCompact.workflow);
		} finally {
			fullHarness.disposeFooter();
			fullLangOnly.disposeFooter();
			compactHarness.disposeFooter();
		}
	});

	it("accumulates spokesman-rewrite custom entry usage without incrementing turns or requests", async () => {
		const activeBranch = [
			{ type: "message", message: { role: "user", timestamp: 1_000 } },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, reasoning: 5, cost: { total: 0.10 } },
				},
			},
			{
				type: "custom",
				customType: "spokesman-rewrite",
				data: {
					provider: "magpie",
					usage: {
						input: 40,
						output: 30,
						cacheRead: 80,
						cacheWrite: 10,
						reasoning: 15,
						cost: { total: 0.05, magpiePricing: "estimate" },
					},
				},
			},
		];
		const harness = createHarness("spokesman-rewrite-usage", "tui", { branch: activeBranch });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const lines = harness.getFooter()!.render(240);
			const row2 = lines[1]!;
			expect(row2).toContain("# 1");
			expect(row2).toContain("~$0.150");
			expect(row2).toContain("$0.150/turn");
			expect(row2).toContain("↑ 140");
			expect(row2).toContain("↓ 80");
			expect(row2).toContain("⚡ 100");
			expect(row2).toContain("20 think");
			await harness.runCommand("footer", "debug");
			expect(harness.notifications.at(-1)).toContain("requests=0");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("paints extension statuses by identity and tone instead of the theme accent", async () => {
		const harness = createHarness("status-tone", "tui", {
			keyedExtensionStatuses: { herder: "herder: T2 integrate", loop: "↻ build", other: "SYNC" },
			theme: { fg: (token, text) => `<${token}>${text}`, bold: (text) => text },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			// Set after startup: the footer's process watcher publishes its own key then.
			harness.setStatus(PROCESS_STATUS_KEY, "bg 1 failed");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			let full = harness.getFooter()!.render(200)[3]!;
			expect(full).toMatch(/^ <borderMuted>╰ <\w+>herder: T2 integrate/);
			expect(full).toContain("<warning>bg 1 failed");
			expect(full).not.toContain("<error>");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			full = harness.getFooter()!.render(200)[3]!;
			expect(full).toContain("\u{F0CC6} ");
			expect(full).toContain("\u{F018D} ");
			expect(full).toContain("\u{F0431} ");
			expect(full).not.toContain("\u{F04E6}");
			await harness.runCommand("footer", "compact");
			const compact = harness.getFooter()!.render(200)[0]!;
			expect(compact).toMatch(/<\w+>herder: T2 integrate/);
			expect(compact).toContain("<warning>bg 1 failed");
			expect(compact).not.toContain("\u{F0CC6}");
			for (const line of [full, compact]) expect(line).not.toMatch(/<(accent|error)>(herder|bg|SYNC|↻)/);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("does not throw or overflow at narrow width with missing model and context", async () => {
		const harness = createHarness("render-boundary-session", "tui", {
			model: null,
			contextUsage: null,
			branch: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const lines = harness.getFooter()!.render(24);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("no-model");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		harness.getFooter()?.dispose?.();
	});
});

describe("statusline footer powerline style", () => {
	type Rgb = { r: number; g: number; b: number };
	const hex = (value: string): Rgb => ({
		r: Number.parseInt(value.slice(1, 3), 16),
		g: Number.parseInt(value.slice(3, 5), 16),
		b: Number.parseInt(value.slice(5, 7), 16),
	});
	const fgCode = ({ r, g, b }: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
	const bgCode = ({ r, g, b }: Rgb) => `\x1b[48;2;${r};${g};${b}m`;
	const SURFACE = "#3a3b40";
	const SURFACE_SGR = "48;2;58;59;64";
	const DIM = "#45464b"; // close to the surface on purpose
	// A truecolor theme like Pi's: tokens open a 24-bit color and close only their own slot,
	// and faint tokens add SGR 2, which they close with 22.
	function rgbTheme(colors: Record<string, string> = {}, surface: string | null = SURFACE, faint = ["dim"]) {
		const palette: Record<string, string> = {
			accent: "#b48ead", text: "#e0e0e0", muted: "#a0a0a8", dim: DIM, borderMuted: "#5c5d63",
			success: "#7dcea0", warning: "#f5b041", error: "#e06c5f", ...colors,
		};
		return {
			fg: (token: string, text: string) => faint.includes(token)
				? `${fgCode(hex(palette[token] ?? "#909090"))}\x1b[2m${text}\x1b[22;39m`
				: `${fgCode(hex(palette[token] ?? "#909090"))}${text}\x1b[39m`,
			bg: (_token: string, text: string) => `${surface ? bgCode(hex(surface)) : "\x1b[49m"}${text}\x1b[49m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		};
	}
	/** Each SGR attribute in an ANSI string with the position of its sequence; colors keep their arguments. */
	function sgr(line: string): Array<{ index: number; code: string }> {
		const attributes: Array<{ index: number; code: string }> = [];
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
			const codes = match[1] === "" ? ["0"] : match[1]!.split(";");
			for (let i = 0; i < codes.length; i++) {
				let code = codes[i] || "0";
				if ((code === "38" || code === "48") && (codes[i + 1] === "2" || codes[i + 1] === "5")) {
					const length = codes[i + 1] === "2" ? 5 : 3;
					code = codes.slice(i, i + length).join(";");
					i += length - 1;
				}
				attributes.push({ index: match.index!, code });
			}
		}
		return attributes;
	}
	/** The background set at `at`, as its SGR parameters, or undefined for the terminal default. */
	function backgroundAt(line: string, at = line.length): string | undefined {
		let background: string | undefined;
		for (const { index, code } of sgr(line)) {
			if (index >= at) break;
			if (code.startsWith("48;")) background = code;
			else if (code === "0" || code === "49") background = undefined;
		}
		return background;
	}
	const claude = { id: "claude-opus-5-5", provider: "anthropic", reasoning: true };
	const longClaude = { id: "claude-opus-5-5-with-an-unusually-long-model-name", provider: "anthropic", reasoning: true };

	it.each(["full", "compact"])("keeps Fast beside the model chip in %s mode", async (mode) => {
		const model: HarnessModel = {
			id: "gpt-6.1-terra", provider: "magpie", api: "openai-responses", reasoning: true,
			magpieServiceTiers: ["priority"], magpiePricing: "estimate",
		};
		const harness = createHarness(`fast-chip-${mode}`, "tui", {
			model, theme: rgbTheme(), extensionStatuses: [], hasPendingMessages: true,
			branch: [{ id: "fast-on", type: "custom", customType: "magpie-fast", data: { enabled: true } }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			const line = harness.getFooter()!.render(160)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
			expect(line).toMatch(/gpt-6\.1-terra\s+(?:\uE0B0\s+)?FAST\s+queued/);
			expect(line.indexOf("FAST")).toBeLessThan(line.indexOf("HIGH"));
			for (let width = 1; width <= 120; width++) {
				const row = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(row), `${width}`).toBeLessThanOrEqual(width);
				if (!row.includes("FAST")) expect(row, `${width}`).not.toContain("FA");
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it("chooses chip ink by contrast and lifts faded colors just enough", () => {
		expect(chipInk(hex("#D97757"))).toEqual(hex("#1b1b1f"));
		expect(chipInk(hex("#0866FF"))).toEqual(hex("#ffffff"));
		const surface = hex("#D1C4E9");
		const faded = hex("#B8B0C0");
		const lifted = legibleOn(faded, surface);
		expect(contrastRatio(faded, surface)).toBeLessThan(3);
		expect(contrastRatio(lifted, surface)).toBeGreaterThanOrEqual(3);
		// Darkened toward black, not replaced by it.
		expect(lifted).not.toEqual(hex("#1b1b1f"));
		expect(lifted.r).toBeLessThan(faded.r);
		const readable = hex("#1DE9B6");
		expect(legibleOn(readable, hex("#1e1e24"))).toBe(readable);
	});

	it("draws the bar as a vendor chip on theme bands and leaves the rows below unfilled", async () => {
		const harness = createHarness("powerline-full", "tui", { model: claude, isIdle: false, branch: [], theme: rgbTheme() });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			const lines = harness.getFooter()!.render(100);
			// The bar, the telemetry and Git rows, and the READY status.
			expect(lines).toHaveLength(4);
			const bar = lines[0]!;
			const chip = `${bgCode(hex("#D97757"))}${fgCode(hex("#1b1b1f"))}\x1b[1m ● \u{EC82} claude-opus-5-5 \x1b[22m`;
			expect(bar.startsWith(chip)).toBe(true);
			expect(bar).toContain(`${bgCode(hex(SURFACE))}${fgCode(hex("#D97757"))}\u{E0B0}`);
			expect(bar).toContain("42.5%");
			expect(bar).toContain("\u{E0B2}");
			// Resets inside the band, such as the gradient bar's, reopen the surface.
			expect(bar).toContain(`\x1b[0m${bgCode(hex(SURFACE))}`);
			// Text that would fade into the band is lifted and drawn at full intensity; the chip keeps its own ink.
			const bandText = bar.slice(bar.indexOf("\u{E0B0}"));
			expect(bandText).toContain("(anthropic)");
			expect(bandText).not.toContain(fgCode(hex(DIM)));
			expect(sgr(bandText).map(({ code }) => code)).not.toContain("2");
			expect(bar.match(/\x1b\[38;2;27;27;31m/g)).toHaveLength(1);
			for (const line of lines.slice(1)) expect(line).not.toContain("\x1b[48;");
			expect(lines[3]).toContain("READY");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("keeps the %s bar within width and closes its bands at every width", async (mode) => {
		const status = "\x1b[32m↻ build\x1b[m · next\x1b[0;2m soon";
		for (const [index, model] of [claude, longClaude, { id: "模型模型模型模型", reasoning: true }, null].entries()) {
			const harness = createHarness(`powerline-sweep-${mode}-${index}`, "tui", {
				model,
				isIdle: index !== 0,
				hasPendingMessages: index === 1,
				keyedExtensionStatuses: { loop: status },
				theme: rgbTheme(),
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				await harness.runCommand("footer", mode);
				for (const nerdFonts of ["0", "1"]) {
					vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
					for (let width = 1; width <= 160; width++) {
						const lines = harness.getFooter()!.render(width);
						for (const line of lines) {
							expect(visibleWidth(line), `${model?.id} at ${width}`).toBeLessThanOrEqual(width);
							expect(backgroundAt(line), `${model?.id} at ${width}`).toBeUndefined();
						}
						const bar = lines[0]!;
						if (width >= 40) expect(bar, `${model?.id} at ${width}`).toContain("42.5%");
						if (width === 160) expect(visibleWidth(bar)).toBe(160);
						if (nerdFonts === "0") expect(bar).not.toMatch(/[\u{E0B0}\u{E0B2}]/u);
						else if (width >= 64) expect(bar).toContain("\u{E0B0}");
						// A status's own resets, bare or compound, reopen the band, and its faint is dropped.
						for (const word of ["next", "soon"]) {
							if (bar.includes(word)) expect(backgroundAt(bar, bar.indexOf(word))).toBe(SURFACE_SGR);
						}
					}
				}
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				if (mode === "compact") {
					const bar = harness.getFooter()!.render(160)[0]!;
					expect(bar).toContain("soon");
					expect(sgr(bar).map(({ code }) => code)).not.toContain("2");
				}
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		}
	});

	describe.each(["full", "compact"])("language in the %s bar", (mode) => {
		const start = async (id: string, model: typeof claude, keyedExtensionStatuses: Record<string, string>, theme?: ReturnType<typeof rgbTheme>) => {
			const harness = createHarness(id, "tui", { model, extensionStatuses: [], keyedExtensionStatuses, theme });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			return harness;
		};

		it.each([
			["English", "flat", claude.id],
			["English", "powerline", claude.id],
			["简体中文", "flat", claude.id],
			["简体中文", "powerline", claude.id],
			["简体中文", "powerline", "模型模型模型模型"],
			["简体中文".repeat(10), "powerline", longClaude.id],
		] as const)("fits %s on the %s bar beside %s and yields to the model and percent at every width", async (language, skin, modelId) => {
			const model = { ...claude, id: modelId };
			const theme = skin === "powerline" ? rgbTheme() : undefined;
			const id = `language-sweep-${mode}-${skin}-${language}-${modelId}`;
			const harness = await start(id, model, { language }, theme);
			const baseline = await start(`${id}-baseline`, model, {}, theme);
			try {
				let shown = 0;
				for (let width = 200; width >= 1; width--) {
					const lines = harness.getFooter()!.render(width);
					const plain = baseline.getFooter()!.render(width);
					for (const line of lines) expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
					// The name goes whole: no stray glyph is ever left behind.
					if (lines[0]!.includes(language)) shown++;
					else expect(lines[0], `${width}`).toBe(plain[0]);
					expect(lines.slice(1), `${width}`).toEqual(plain.slice(1));
					for (const whole of [model.id, "42.5%"]) {
						if (plain[0]!.includes(whole)) expect(lines[0], `${width}`).toContain(whole);
					}
				}
				expect(shown).toBeGreaterThan(0);
				expect(shown).toBeLessThan(200);
			} finally {
				harness.disposeFooter();
				baseline.disposeFooter();
			}
		});
	});

	it("keeps a chip that truncation cuts into on its own color and closes it", async () => {
		const harness = createHarness("powerline-cut-chip", "tui", { model: longClaude, theme: rgbTheme() });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			for (const width of [40, 56]) {
				const bar = harness.getFooter()!.render(width)[0]!;
				const cut = bar.indexOf("...");
				expect(cut, `${width}`).toBeGreaterThan(0);
				expect(bar.slice(0, cut)).toContain("claude-opus");
				expect(backgroundAt(bar, cut)).toBe("48;2;217;119;87");
				expect(bar.slice(cut)).toContain(`${bgCode(hex(SURFACE))}${fgCode(hex("#D97757"))}\u{E0B0}`);
				expect(bar).toContain("42.5%");
				expect(visibleWidth(bar)).toBe(width);
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("follows a theme that Pi swaps behind the same object", async () => {
		let current: object = rgbTheme({}, null);
		const theme = new Proxy({}, { get: (_target, key) => Reflect.get(current, key) });
		const harness = createHarness("powerline-theme-swap", "tui", { model: claude, theme: theme as ReturnType<typeof rgbTheme> });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			// No band in the first theme: a flat bar over the same rows.
			let lines = harness.getFooter()!.render(100);
			expect(lines).toHaveLength(4);
			expect(lines[0]).not.toContain("\x1b[48;");
			current = rgbTheme();
			lines = harness.getFooter()!.render(100);
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain(bgCode(hex(SURFACE)));
			current = rgbTheme({ borderMuted: "#aa3355" }, "#20304a");
			lines = harness.getFooter()!.render(100);
			expect(lines[0]).toContain(bgCode(hex("#20304a")));
			expect(lines[0]).not.toContain(bgCode(hex(SURFACE)));
			expect(lines[0]).toContain(`${fgCode(hex("#aa3355"))}─`);
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps bands, caps, and the rule on a 256-color theme but draws no truecolor chip", async () => {
		const theme = {
			fg: (token: string, text: string) => `\x1b[38;5;${token === "borderMuted" ? 245 : 238}m${text}\x1b[39m`,
			bg: (_token: string, text: string) => `\x1b[48;5;254m${text}\x1b[49m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		};
		const harness = createHarness("powerline-256", "tui", { model: claude, theme });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			const bar = harness.getFooter()!.render(120)[0]!;
			expect(bar).toContain("\x1b[48;5;254m");
			expect(bar).not.toContain("\x1b[48;2;");
			expect(bar).toContain("\x1b[38;5;254m\u{E0B0}");
			expect(bar).toContain("\x1b[38;5;245m─");
			expect(backgroundAt(bar, bar.indexOf("claude-opus-5-5"))).toBe("48;5;254");
			// HIGH is drawn in truecolor; on the light band (xterm 254) it is lifted to 3:1.
			const high = /\x1b\[38;2;(\d+);(\d+);(\d+)mHIGH/.exec(bar);
			expect(high).not.toBeNull();
			const [r, g, b] = high!.slice(1).map(Number) as [number, number, number];
			expect(contrastRatio({ r, g, b }, { r: 228, g: 228, b: 228 })).toBeGreaterThanOrEqual(3);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	describe("detail rows", () => {
		// Distinct colors for the tokens the rows use, so each assertion can name its token.
		const colors = { toolDiffAdded: "#2e9e4f", toolDiffRemoved: "#d0453a", syntaxFunction: "#3fa7b5" };
		const tones: Record<string, string> = {
			text: "#e0e0e0", muted: "#a0a0a8", dim: DIM, borderMuted: "#5c5d63", success: "#7dcea0", warning: "#f5b041", ...colors,
		};
		const tone = (token: string) => fgCode(hex(tones[token]!));
		const tagged = rgbTheme(colors);
		const activeBranch = [
			{ type: "message", message: { role: "user", timestamp: Date.now() - 3_600_000 } },
			{ type: "message", message: { role: "user", timestamp: Date.now() } },
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					usage: { input: 65_200, output: 31_400, cacheRead: 120_000, cacheWrite: 0, reasoning: 12_100, cost: { total: 0.75 } },
					content: [{ type: "toolCall", arguments: { path: "src/a.ts" } }, { type: "toolCall", arguments: { path: "src/b.ts" } }],
				},
			},
		];
		const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
		// The icon that marks each group, with the groups in the order they give way.
		const nerd = { think: "think", tools: "\u{F05B7}", activity: "\u{F0368}", tokens: "\u{F005E}", latency: "\u{F051B}", cost: "\u{F01C1}" };

		it("hangs the telemetry, Git, and status rows from the bar on a rail", async () => {
			const harness = createHarness("detail-rail", "tui", {
				model: claude,
				branch: activeBranch,
				extensionStatuses: [],
				keyedExtensionStatuses: { herder: "herder: T2 integrate · 3/5 tasks", loop: "↻ build · next 4m" },
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				let lines = harness.getFooter()!.render(160);
				expect(lines).toHaveLength(4);
				expect(lines.slice(1).map(line => strip(line).slice(0, 3))).toEqual([" ├ ", " ├ ", " ╰ "]);
				const [, telemetry, git, statuses] = lines as [string, string, string, string];
				// Chevrons point the way the bar's arrows do on each side.
				expect(telemetry).toContain(`${tone("borderMuted")}\u{E0B1}`);
				expect(telemetry).toContain(`${tone("borderMuted")}\u{E0B3}`);
				expect(statuses).toContain(`${tone("borderMuted")}\u{E0B1}`);
				// Icons carry the hue, values stay quiet, and the cost leads.
				const item = (hue: string, icon: string, value: string, valueTone = "muted") =>
					`${tone(hue)}\x1b[1m${icon}\x1b[22m\x1b[39m ${tone(valueTone)}${value}`;
				expect(telemetry).toContain(item("warning", nerd.cost, "$0.750", "text"));
				expect(telemetry).toContain(`${tone("dim")}\x1b[2m  $0.375/turn`);
				expect(telemetry).toContain(item("toolDiffAdded", nerd.tokens, "65k"));
				expect(telemetry).toContain(item("syntaxFunction", nerd.tools, "2"));
				// 120k of 185k input tokens were cached: 65%, below the 70% that rates success.
				expect(telemetry).toContain(`${tone("warning")}65%`);
				expect(strip(telemetry)).not.toContain("(~");
				expect(strip(git)).toContain("main");
				expect(strip(git)).toContain("2 touched");
				expect(strip(statuses)).toContain("↻ build · next 4m");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(160);

				for (const key of ["herder", "loop"]) harness.setStatus(key);
				lines = harness.getFooter()!.render(160);
				expect(lines).toHaveLength(3);
				expect(strip(lines[2]!).slice(0, 3)).toBe(" ╰ ");

				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				const plainFonts = harness.getFooter()!.render(160)[1]!;
				expect(plainFonts).toContain(`${tone("borderMuted")}│`);
				expect(plainFonts).not.toMatch(/[\u{E0B1}\u{E0B3}]/u);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("drops whole groups, least important first, and shortens the path from the middle", async () => {
			const harness = createHarness("detail-fit", "tui", {
				model: claude,
				branch: activeBranch,
				extensionStatuses: [],
				cwd: `/tmp/${"deep/".repeat(12)}project`,
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				const narrowest: Record<string, number> = {};
				for (let width = 200; width >= 30; width--) {
					const [, telemetry, git] = harness.getFooter()!.render(width).map(strip) as [string, string, string, string];
					expect(visibleWidth(telemetry), `${width}`).toBeLessThanOrEqual(width);
					expect(visibleWidth(git), `${width}`).toBeLessThanOrEqual(width);
					// Groups give way whole; nothing is cut mid-word.
					expect(telemetry, `${width}`).not.toContain("...");
					expect(git, `${width}`).not.toContain("...");
					// Below 40 columns the path no longer fits beside the branch.
					if (width >= 40) expect(git.trimEnd().endsWith("/project"), `${width}`).toBe(true);
					for (const [group, marker] of Object.entries(nerd)) if (telemetry.includes(marker)) narrowest[group] = width;
				}
				expect(narrowest.cost).toBe(30);
				const order = ["think", "tools", "activity", "tokens", "latency", "cost"].map(group => narrowest[group]!);
				expect(order).toEqual([...order].sort((a, b) => b - a));
				expect(new Set(order).size).toBe(order.length);
				// The file count stays while the path keeps twelve columns, then gives way to it.
				const roomy = strip(harness.getFooter()!.render(80)[2]!);
				expect(roomy).toContain("/…/");
				expect(roomy).toContain("2 touched");
				const narrow = strip(harness.getFooter()!.render(44)[2]!);
				expect(narrow).toContain(" /…/deep/deep/project");
				expect(narrow).not.toContain("touched");
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("shortens a path from the middle and keeps its last directory", () => {
			expect(shortenPath("~/a/b/c/project", 20)).toBe("~/a/b/c/project");
			expect(shortenPath("~/a/b/c/project", 14)).toBe("~/…/c/project");
			expect(shortenPath("/tmp/deep/deep/project", 12)).toBe("/…/project");
			expect(shortenPath("~/深い/階層/プロジェクト", 16)).toBe("~/…/プロジェクト");
			expect(shortenPath("/tmp/averyverylongprojectname", 8)).toBe("averyve…");
			expect(shortenPath("~/x/プロジェクト", 6)).toBe("プロ…");
			for (const max of [1, 4, 9]) expect(visibleWidth(shortenPath("~/x/averyverylongprojectname", max))).toBeLessThanOrEqual(max);
		});
	});

	it("keeps the rail rows under a flat bar when the theme's band is the terminal default", async () => {
		const harness = createHarness("powerline-default-surface", "tui", { model: claude, theme: rgbTheme({}, null) });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			const lines = harness.getFooter()!.render(100);
			expect(lines).toHaveLength(4);
			for (const line of lines) expect(line).not.toContain("\x1b[48;");
			expect(lines[0]).toContain("claude-opus-5-5");
			expect(lines[0]).toContain("42.5%");
			expect(lines[0]).not.toMatch(/[\u{E0B0}\u{E0B2}]/u);
			const rails = lines.slice(1).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 3));
			expect(rails).toEqual([" ├ ", " ├ ", " ╰ "]);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("has one look, so /footer rejects the old style arguments", async () => {
		const harness = createHarness("powerline-command", "tui", { model: claude, theme: rgbTheme() });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			await harness.runCommand("footer", "compact");
			expect(harness.notifications.at(-1)).toBe("Statusline footer: compact mode");
			expect(harness.getFooter()!.render(100)[0]).toContain("\x1b[48;");
			for (const style of ["plain", "powerline"]) {
				await harness.runCommand("footer", style);
				expect(harness.notifications.at(-1)).toBe(`Unknown /footer argument '${style}' — usage: /footer [full|compact|off|debug]`);
			}
			expect(harness.getFooter()!.render(100)).toHaveLength(1);
		} finally {
			harness.disposeFooter();
		}
	});
});

describe("statusline footer pi-processes compatibility", () => {
	// @aliou/pi-processes 0.13.2: extensions/shared/protocol/{channels,requests}.ts.
	// List replies are synchronous; changed broadcasts carry only a reason.
	function manager(events: ExtensionAPI["events"], initial: unknown = []) {
		let processes = initial;
		const list = vi.fn((payload: unknown) => {
			(payload as { reply: (value: unknown) => void }).reply(processes);
		});
		const dispose = events.on("processes:request:list", list);
		return {
			list, dispose,
			update(value: unknown, broadcast = true) {
				processes = value;
				if (broadcast) events.emit("processes:changed", { reason: "ended" });
			},
		};
	}

	it("summarizes upstream states without including command or process text", () => {
		expect(summarizeProcesses([
			{ status: "running", name: "\x1b[2Junsafe" },
			{ status: "running" }, { status: "terminating" }, { status: "terminate_timeout" },
			{ status: "exited", success: false }, { status: "exited", success: true },
			{ status: "killed" }, null, { status: "unknown" },
		])).toBe("bg 2 running · 1 stopping · 1 stuck · 1 failed · 1 done · 1 killed");
		for (const value of [undefined, null, {}, [], [null, { status: "unknown" }]]) {
			expect(summarizeProcesses(value)).toBeUndefined();
		}
	});

	it("stays empty when pi-processes is absent", async () => {
		const harness = createHarness("processes-absent", "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			for (const mode of ["full", "compact"]) {
				await harness.runCommand("footer", mode);
				expect(harness.getFooter()!.render(240).join("\n")).not.toContain("bg ");
			}
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
		}
	});

	it("loads an initial snapshot, reacts to completion and clears removed tasks", async () => {
		const harness = createHarness("processes-events", "tui");
		const core = manager(harness.events, [{ status: "running" }]);
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			expect(harness.getFooter()!.render(240)[3]).toContain("bg 1 running");
			core.update([{ status: "exited", success: false }, { status: "running" }]);
			expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(PROCESS_STATUS_KEY, "bg 1 running · 1 failed");
			expect(harness.getFooter()!.render(240)[3]).toContain("bg 1 running · 1 failed");
			core.update([{ status: "exited", success: true }]);
			expect(harness.getFooter()!.render(240)[3]).toContain("bg 1 done");
			core.update([]);
			expect(harness.getFooter()!.render(240)[3]).not.toContain("bg ");
			core.update({ invalid: true });
			expect(harness.getFooter()!.render(240)[3]).not.toContain("bg ");
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			core.dispose();
		}
	});

	it("reconciles silent termination transitions and releases its timer", async () => {
		vi.useFakeTimers();
		const harness = createHarness("processes-silent-transitions", "tui");
		const core = manager(harness.events, [{ status: "running" }]);
		try {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			expect(vi.getTimerCount()).toBe(2); // Footer duration + live process metadata.
			const publications = vi.mocked(harness.ctx.ui.setStatus).mock.calls.length;
			await vi.advanceTimersByTimeAsync(2_000);
			expect(harness.ctx.ui.setStatus).toHaveBeenCalledTimes(publications);
			core.update([{ status: "terminating" }], false);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(harness.getFooter()!.render(120)[3]).toContain("bg 1 stopping");
			core.update([{ status: "terminate_timeout" }], false);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(harness.getFooter()!.render(120)[3]).toContain("bg 1 stuck");
			core.update([{ status: "killed" }]);
			expect(vi.getTimerCount()).toBe(1);
			core.update([{ status: "running" }]);
			expect(vi.getTimerCount()).toBe(2);
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			expect(vi.getTimerCount()).toBe(0);
			const calls = core.list.mock.calls.length;
			await vi.advanceTimersByTimeAsync(4_000);
			core.update([]);
			expect(core.list).toHaveBeenCalledTimes(calls);
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			core.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps the full-mode status row apart from a long path and bounds compact mode", async () => {
		const harness = createHarness("processes-layout", "tui", {
			cwd: `/tmp/${"very-long/".repeat(30)}project`,
		});
		const core = manager(harness.events, [{ status: "running" }]);
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const full = harness.getFooter()!.render(55);
			expect(full[2]).toContain("main");
			expect(full[3]).toContain("bg 1 running");
			expect(full[3]!.split("bg 1 running")).toHaveLength(2);
			await harness.runCommand("footer", "compact");
			for (const width of [0, 1, 12, 24, 40, 80, 120]) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 24) {
					expect(line).toContain("k3");
					expect(line).toContain("42.5%");
				}
				if (width >= 40) expect(line).toContain("bg 1 running");
				if (width === 24) expect(line).not.toContain("bg ");
			}
			harness.setStatus("autoresearch", "research 2/5");
			harness.setStatus("loop", "loop build");
			const wide = harness.getFooter()!.render(160)[0]!;
			expect(wide).toContain("research 2/5");
			expect(wide).toContain("bg 1 running");
			expect(wide).not.toContain("loop build");
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			core.dispose();
		}
	});

	it("keeps updating while the custom footer is off", async () => {
		const harness = createHarness("processes-footer-off", "tui");
		const core = manager(harness.events);
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			await harness.runCommand("footer", "off");
			core.update([{ status: "running" }]);
			expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(PROCESS_STATUS_KEY, "bg 1 running");
			expect(harness.getFooter()).toBeUndefined();
			await harness.runCommand("footer", "compact");
			expect(harness.getFooter()!.render(120)[0]).toContain("bg 1 running");
		} finally {
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			core.dispose();
		}
	});

	it("ignores child sessions and removes subscriptions on shutdown and reload", async () => {
		const root = createHarness("processes-isolation", "tui");
		const child = createHarness("processes-isolation", "print", { events: root.events });
		const core = manager(root.events, [{ status: "running" }]);
		for (const harness of [root, child]) {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
		}
		try {
			expect(core.list).toHaveBeenCalledTimes(1);
			await child.emit("session_shutdown", { reason: "quit" });
			expect(child.ctx.ui.setStatus).not.toHaveBeenCalled();
			core.update([{ status: "exited", success: true }]);
			expect(root.getFooter()!.render(120)[3]).toContain("bg 1 done");
			root.disposeFooter();
			await root.emit("session_shutdown", { reason: "reload" });
			expect(root.ctx.ui.setStatus).toHaveBeenLastCalledWith(PROCESS_STATUS_KEY, undefined);
			const calls = core.list.mock.calls.length;
			core.update([]);
			expect(core.list).toHaveBeenCalledTimes(calls);
			await root.emit("session_start", { reason: "reload" });
			core.list.mockClear();
			core.update([{ status: "running" }]);
			expect(core.list).toHaveBeenCalledTimes(1);
			expect(root.getFooter()!.render(120)[3]).toContain("bg 1 running");
		} finally {
			root.disposeFooter();
			await root.emit("session_shutdown", { reason: "quit" });
			core.dispose();
		}
	});
});

describe("statusline footer pricing", () => {
	const usage = (total: number, magpiePricing?: "estimate" | "unavailable", tokens = { input: 20, output: 5, cacheRead: 2, cacheWrite: 1 }) => ({
		...tokens, cost: { total, ...(magpiePricing ? { magpiePricing } : {}) },
	});
	const assistant = (provider: string, total: number, marker?: "estimate" | "unavailable") => ({
		type: "message", message: { role: "assistant", provider, usage: usage(total, marker) },
	});
	const freeModel = { id: "free", provider: "other", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

	it.each(["full", "compact"] as const)("shows unavailable %s pricing alongside other providers' usage", async (mode) => {
		const harness = createHarness(`pricing-mixed-${mode}`, "tui", {
			model: freeModel,
			branch: [
				{ type: "message", message: { role: "user" } },
				assistant("other", 1.25),
				assistant("magpie", 0, "unavailable"),
			],
		});
		try {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			const lines = harness.getFooter()!.render(240);
			const priceLine = mode === "full" ? lines[1]! : lines[0]!;
			expect(priceLine).toContain("price unavailable");
			expect(priceLine).not.toContain("$1.25");
			expect(priceLine).not.toContain("/turn");
			if (mode === "full") {
				expect(priceLine).toContain("40"); // Both providers' input tokens remain counted.
				expect(priceLine).toContain("10"); // Both providers' output tokens remain counted.
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps legacy zero-cost Magpie history unavailable after switching to a priced model", async () => {
		const harness = createHarness("pricing-legacy-history", "tui", {
			model: { id: "priced", provider: "other" },
			branch: [assistant("magpie", 0), assistant("other", 2)],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const line = harness.getFooter()!.render(240)[1]!;
		expect(line).toContain("price unavailable");
		expect(line).not.toContain("$2.00");
		harness.disposeFooter();
	});

	it("keeps known free costs from other providers at zero", async () => {
		const harness = createHarness("pricing-free-other", "tui", {
			model: freeModel, branch: [assistant("other", 0)],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[1]).toContain("$0.000");
		expect(harness.getFooter()!.render(240)[1]).not.toContain("price unavailable");
		harness.disposeFooter();
	});

	it("counts explicit known zero pricing as free and marks positive untagged Magpie costs estimated", async () => {
		const harness = createHarness("pricing-estimates", "tui", {
			model: freeModel,
			branch: [
				{ type: "message", message: { role: "user" } },
				assistant("magpie", 0, "estimate"),
				assistant("magpie", 0.75),
				assistant("other", 0),
			],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const full = harness.getFooter()!.render(240)[1]!;
		expect(full).toContain("~$0.750");
		expect(full).toContain("/turn");
		await harness.runCommand("footer", "compact");
		expect(harness.getFooter()!.render(240)[0]).toContain("~$0.750");
		harness.disposeFooter();
	});

	it.each(["toolResult", "compaction", "branch_summary"] as const)("honors explicit pricing on %s usage", async (source) => {
		const entry = source === "toolResult"
			? { type: "message", message: { role: "toolResult", usage: usage(0, "unavailable") } }
			: { type: source, usage: usage(0, "unavailable") };
		const harness = createHarness(`pricing-${source}`, "tui", { branch: [entry] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[1]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it.each(["input", "output", "cacheRead", "cacheWrite"] as const)("treats %s tokens with unavailable pricing as unpriced", async (counter) => {
		const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [counter]: 1 };
		const harness = createHarness(`pricing-${counter}-only`, "tui", {
			branch: [{ type: "compaction", usage: usage(0, "unavailable", tokens) }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[1]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it("keeps zero-token unavailable usage out of the missing-price count", async () => {
		const harness = createHarness("pricing-empty-usage", "tui", {
			branch: [{ type: "compaction", usage: usage(0, "unavailable", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[1]).toContain("$0.000");
		expect(harness.getFooter()!.render(240)[1]).not.toContain("price unavailable");
		harness.disposeFooter();
	});

	it("treats explicitly estimated native compaction usage as priced even at zero cost", async () => {
		const harness = createHarness("pricing-compaction-estimate", "tui", {
			branch: [{ type: "compaction", usage: usage(0, "estimate") }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[1]).toContain("~$0.000");
		harness.disposeFooter();
	});

	it.each(["unavailable", "estimate"] as const)("retains %s provenance when Pi merges split-summary usage", async pricing => {
		const harness = createHarness(`pricing-merged-summary-${pricing}`, "tui", {
			model: freeModel,
			branch: [
				{ type: "custom", customType: "magpie-pricing", data: { pricing } },
				{ type: "compaction", usage: usage(pricing === "estimate" ? 0.25 : 0) },
			],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "resume" });
		const line = harness.getFooter()!.render(240)[1]!;
		expect(line).toContain(pricing === "unavailable" ? "price unavailable" : "~$0.250");
		harness.disposeFooter();
	});

	it("shows selected Magpie model's unavailable price before any usage", async () => {
		const harness = createHarness("pricing-current-empty", "tui", {
			model: { ...freeModel, id: "unpriced", provider: "magpie", magpiePricing: "unavailable" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[1]).toContain("price unavailable");
		await harness.runCommand("footer", "compact");
		expect(harness.getFooter()!.render(240)[0]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it("reads the current model on every render, even at the same branch leaf", async () => {
		const harness = createHarness("pricing-model-switch", "tui", { model: freeModel, branch: [assistant("other", 1)] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const full = () => harness.getFooter()!.render(240)[1]!;
		expect(full()).toContain("$1.00");
		harness.ctx.model = { ...freeModel, id: "unpriced", provider: "magpie", magpiePricing: "unavailable" } as unknown as typeof harness.ctx.model;
		expect(full()).toContain("price unavailable");
		await harness.runCommand("footer", "compact");
		expect(harness.getFooter()!.render(240)[0]).toContain("price unavailable");
		harness.ctx.model = { ...freeModel, id: "legacy", provider: "magpie" } as typeof harness.ctx.model;
		expect(harness.getFooter()!.render(240)[0]).toContain("price unavailable");
		harness.ctx.model = { ...freeModel, id: "known-free", provider: "magpie", magpiePricing: "estimate" } as unknown as typeof harness.ctx.model;
		expect(harness.getFooter()!.render(240)[0]).toContain("$1.00");
		harness.disposeFooter();
	});

	it("renders one dollar symbol with ASCII icons and keeps the Nerd Font cost glyph", async () => {
		const harness = createHarness("pricing-icons", "tui", { branch: [assistant("other", 1)] });
		try {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			for (const mode of ["full", "compact"]) {
				await harness.runCommand("footer", mode);
				const priceLine = harness.getFooter()!.render(240)[mode === "full" ? 1 : 0]!;
				expect(priceLine).toContain("$1.00");
				expect(priceLine).not.toMatch(/\$\s+\$1\.00/);
			}
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			expect(harness.getFooter()!.render(240)[0]).toContain(`${String.fromCodePoint(0xF01C1)} $1.00`);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});
});

describe("statusline footer degraded stream lifecycle", () => {
	it.each(["text_delta", "thinking_delta", "toolcall_delta"])("waits for real content in %s", async (type) => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness(`first-content-${type}`, "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_100;
		for (const [startType, block] of [
			["text_start", { type: "text", text: "" }],
			["thinking_start", { type: "thinking", thinking: "" }],
			["toolcall_start", { type: "toolCall", name: "", arguments: {} }],
		] as const) {
			await harness.emit("message_update", {
				type: "message_update",
				assistantMessageEvent: { type: startType, contentIndex: 0, partial: { content: [block] } },
			});
		}
		for (const deltaType of ["text_delta", "thinking_delta", "toolcall_delta"]) {
			await harness.emit("message_update", {
				type: "message_update", assistantMessageEvent: { type: deltaType, delta: "" },
			});
		}
		now = 1_600;
		await harness.emit("message_update", {
			type: "message_update", assistantMessageEvent: { type, delta: "content" },
		});
		now = 1_800;
		await harness.emit("message_update", {
			type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "more" },
		});
		now = 2_600;
		await harness.emit("message_end", assistantEnd(10));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=1");
		expect(harness.notifications.at(-1)).toContain("avgTtft=600 lastTtft=600 lastTok/s=6.3");
		harness.disposeFooter();
	});

	it.each([
		["text_start", { type: "text", text: "hello" }],
		["thinking_start", { type: "thinking", thinking: "considering" }],
		["toolcall_start", { type: "toolCall", name: "read", arguments: {} }],
	])("counts initial content in %s", async (type, block) => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness(`initial-content-${type}`, "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_200;
		await harness.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: {
				type, contentIndex: 1, partial: { content: [{ type: "text", text: "" }, block] },
			},
		});
		now = 2_200;
		await harness.emit("message_end", assistantEnd(20));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=1");
		expect(harness.notifications.at(-1)).toContain("avgTtft=200 lastTtft=200 lastTok/s=16.7");
		harness.disposeFooter();
	});

	it("rejects empty-only streams despite a request marker and output usage", async () => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("empty-only-stream", "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_200;
		await harness.emit("message_update", {
			type: "message_update", assistantMessageEvent: {
				type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] },
			},
		});
		await harness.emit("message_update", {
			type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "" },
		});
		now = 2_200;
		await harness.emit("message_end", assistantEnd(20));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=0");
		expect(harness.notifications.at(-1)).toContain("avgTtft=- lastTtft=- lastTok/s=-");
		harness.disposeFooter();
	});

	it("uses the assistant start fallback and keeps response diagnostics isolated", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("fallback-stream", "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		now = 1_000;
		await harness.emit("message_start", { type: "message_start", message: { role: "assistant" } });
		now = 1_100;
		await harness.emit("after_provider_response", { type: "after_provider_response" });
		now = 1_150;
		await harness.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		now = 2_150;
		await harness.emit("message_end", assistantEnd(10));
		await harness.runCommand("footer", "debug");

		let debug = harness.notifications.at(-1)!;
		expect(debug).toContain("headersSeen=0 responsesSeen=1 requests=1");
		expect(debug).toContain("lastTtfb=100");
		expect(debug).toContain("avgTtft=150");
		expect(debug).toContain("lastTok/s=8.7");

		now = 3_000;
		await harness.emit("after_provider_response", { type: "after_provider_response" });
		await harness.runCommand("footer", "debug");
		debug = harness.notifications.at(-1)!;
		expect(debug).toContain("responsesSeen=2 requests=1");
		expect(debug).toContain("lastTtfb=100");

		const noMarker = createHarness("response-without-marker", "tui");
		statuslineFooter(noMarker.pi);
		await noMarker.emit("session_start", { type: "session_start", reason: "startup" });
		await noMarker.emit("after_provider_response", { type: "after_provider_response" });
		await noMarker.runCommand("footer", "debug");
		expect(noMarker.notifications.at(-1)).toContain("headersSeen=0 responsesSeen=1 requests=0");
		expect(noMarker.notifications.at(-1)).toContain("lastTtfb=-");
		noMarker.disposeFooter();

		const print = createHarness("fallback-print", "print");
		statuslineFooter(print.pi);
		await print.emit("session_start", { type: "session_start", reason: "startup" });
		await print.emit("message_start", { type: "message_start", message: { role: "assistant" } });
		await print.emit("after_provider_response", { type: "after_provider_response" });
		await print.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "ignored" },
		});
		await print.emit("message_end", assistantEnd(10));
		await print.runCommand("footer", "debug");
		expect(print.notifications.at(-1)).toContain("metrics unavailable outside the TUI session");

		harness.disposeFooter();
	});

	it("does not retain rejected samples or contaminate the next valid stream", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("rejected-streams", "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const sample = async (start: number, firstToken: number, end: number, endEvent: any) => {
			now = start;
			await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
			now = firstToken;
			await harness.emit("message_update", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "sample" },
			});
			now = end;
			await harness.emit("message_end", endEvent);
		};

		await sample(1_000, 1_100, 2_100, { message: { role: "assistant" } });
		await sample(3_000, 3_100, 4_100, assistantEnd(0));
		await sample(5_000, 5_010, 5_040, assistantEnd(10));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=0");
		expect(harness.notifications.at(-1)).toContain("lastTok/s=-");
		expect(harness.requestRender).toHaveBeenCalledTimes(3);

		await sample(6_000, 6_100, 7_100, assistantEnd(20));
		await harness.runCommand("footer", "debug");
		const debug = harness.notifications.at(-1)!;
		expect(debug).toContain("headersSeen=4 responsesSeen=0 requests=1");
		expect(debug).toContain("avgTtft=100");
		expect(debug).toContain("lastTtft=100");
		expect(debug).toContain("lastTok/s=18.2");
		harness.disposeFooter();
	});

	it("measures whole calls, so a burst after a long wait or a failed call does not read as a fast stream", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("burst-streams", "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const call = async (start: number, firstToken: number, end: number, endEvent: any) => {
			now = start;
			await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
			now = firstToken;
			await harness.emit("message_update", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
			now = end;
			await harness.emit("message_end", endEvent);
		};
		// 1,440 tokens 100 ms after a first token that took 24 s: 60 tok/s, not the 14,400 the time after the first token gave.
		await call(1_000, 24_900, 25_000, assistantEnd(1_440));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=1");
		expect(harness.notifications.at(-1)).toContain("lastTok/s=60.0");
		// Failed and aborted calls leave the rate alone.
		for (const stopReason of ["error", "aborted"]) {
			await call(30_000, 30_100, 31_100, { message: { role: "assistant", stopReason, usage: { output: 500 } } });
		}
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=1");
		expect(harness.notifications.at(-1)).toContain("lastTok/s=60.0");
		harness.disposeFooter();
	});

	it("owns one timer and subscription through replacement, off, and re-enable", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness("footer-resources", "tui");
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			expect(harness.footerInstallCount()).toBe(1);
			expect(harness.branchSubscribe).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);

			const first = harness.getFooter();
			await harness.runCommand("footer", "compact");
			expect(harness.getFooter()).not.toBe(first);
			expect(harness.footerInstallCount()).toBe(2);
			expect(harness.footerDisposeCount()).toBe(1);
			expect(harness.branchUnsubscribe).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);

			await harness.runCommand("footer", "off");
			expect(harness.getFooter()).toBeUndefined();
			expect(harness.footerDisposeCount()).toBe(2);
			expect(harness.branchUnsubscribe).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);

			await harness.runCommand("footer", "full");
			expect(harness.footerInstallCount()).toBe(3);
			expect(harness.branchSubscribe).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(1);
			harness.disposeFooter();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("removes quit state while reload keeps completed metrics on a new component", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("cleanup-state", "tui");
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		now = 1_000;
		await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_100;
		await harness.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		});
		now = 2_100;
		await harness.emit("message_end", assistantEnd(20));
		const oldFooter = harness.getFooter();
		harness.disposeFooter();
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		expect(harness.getFooter()).not.toBe(oldFooter);
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=1");

		harness.disposeFooter();
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=0");
		harness.disposeFooter();
	});
});

describe("statusline footer session isolation", () => {
	it.each(["full", "compact"])("shows the Magpie Fast switch immediately after the model in %s mode", async (mode) => {
		const model: HarnessModel = {
			id: "gpt-6.1-terra", provider: "magpie", api: "openai-responses", reasoning: true,
			magpieServiceTiers: ["priority"], magpiePricing: "estimate",
		};
		const branch: any[] = [];
		const catalog = [model];
		const harness = createHarness(`magpie-fast-${mode}`, "tui", {
			model, registryModels: catalog, branch, extensionStatuses: [], hasPendingMessages: true,
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", mode);
		const line = () => harness.getFooter()!.render(160)[0]!;
		try {
			expect(line()).toContain(`${model.id}  FAST OFF`);
			branch.push({ id: "on", type: "custom", customType: "magpie-fast", data: { enabled: true } });
			expect(line()).toContain(`${model.id}  FAST`);
			expect(line()).not.toContain("FAST OFF");
			expect(line().indexOf("FAST")).toBeLessThan(line().indexOf("HIGH"));
			await harness.emit("before_provider_request", { payload: { service_tier: "priority" } });
			branch.push({ id: "off", type: "custom", customType: "magpie-fast", data: { enabled: false } });
			expect(line()).toContain(`${model.id}  FAST OFF`);
			await harness.emit("before_provider_request", { payload: { service_tier: "flex" } });
			expect(line()).toContain(`${model.id}  FAST OFF  FLEX`);
			await harness.emit("before_provider_request", { payload: { service_tier: "priority" } });

			// Navigating back restores the branch's state without a provider request.
			branch.pop();
			expect(line()).toContain(`${model.id}  FAST`);
			expect(line()).not.toContain("FAST OFF");
			catalog.splice(0);
			expect(line()).not.toContain("FAST");
			catalog.push(model);
			harness.ctx.model = { ...model, provider: "other" } as typeof harness.ctx.model;
			await harness.emit("model_select", { type: "model_select" });
			expect(line()).not.toContain("FAST");
			harness.ctx.model = model as typeof harness.ctx.model;
			await harness.emit("model_select", { type: "model_select" });
			expect(line()).toContain(`${model.id}  FAST`);
		} finally {
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("drops the Fast badge whole at narrow widths in %s mode", async (mode) => {
		const model: HarnessModel = {
			id: "gpt-6.1-terra", provider: "magpie", api: "openai-responses", reasoning: true,
			magpieServiceTiers: ["priority"], magpiePricing: "estimate",
		};
		const harness = createHarness(`magpie-fast-width-${mode}`, "tui", { model, extensionStatuses: [] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			let shown = false;
			let hidden = false;
			for (let width = 1; width <= 120; width++) {
				const row = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(row), `${width}`).toBeLessThanOrEqual(width);
				if (row.includes("FAST OFF")) shown = true;
				else {
					hidden = true;
					expect(row, `${width}`).not.toContain("FA");
				}
			}
			expect({ shown, hidden }).toEqual({ shown: true, hidden: true });
		} finally {
			harness.disposeFooter();
		}
	});

	it.each([{}, { service_tier: "standard" }])("replaces stale priority tier with %j and clears it on model switch", async (payload) => {
		const root = createHarness(`tier-root-${JSON.stringify(payload)}`, "tui");
		const other = createHarness(`tier-other-${JSON.stringify(payload)}`, "tui");
		const print = createHarness(root.ctx.sessionManager.getSessionId(), "print");
		for (const harness of [root, other, print]) {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			await harness.emit("before_provider_request", { payload: { service_tier: "priority" } });
		}
		expect(root.getFooter()!.render(240)[0]).toContain("FAST");
		await root.emit("before_provider_request", { payload });
		expect(root.getFooter()!.render(240)[0]).not.toContain("FAST");
		expect(other.getFooter()!.render(240)[0]).toContain("FAST");

		await root.emit("before_provider_request", { payload: { service_tier: "priority" } });
		await print.emit("before_provider_request", { payload: {} });
		await print.emit("model_select", { type: "model_select" });
		expect(root.getFooter()!.render(240)[0]).toContain("FAST");
		expect(root.requestRender).not.toHaveBeenCalled();
		await root.emit("model_select", { type: "model_select" });
		expect(root.getFooter()!.render(240)[0]).not.toContain("FAST");
		expect(root.requestRender).toHaveBeenCalledOnce();
		expect(other.getFooter()!.render(240)[0]).toContain("FAST");
		root.disposeFooter();
		other.disposeFooter();
	});

	it("ignores overlapping pi-subagents streams and shutdowns", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const root = createHarness("root-session", "tui");
		const child = createHarness("child-session", "print");
		statuslineFooter(root.pi);
		statuslineFooter(child.pi);

		await root.emit("session_start", { type: "session_start", reason: "startup" });
		expect(root.getFooter()).toBeDefined();

		now = 1_000;
		await root.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_200;
		await root.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "root" },
		});

		await child.emit("session_start", { type: "session_start", reason: "startup" });
		now = 1_300;
		await child.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 1_800;
		await child.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "child" },
		});
		now = 1_900;
		await child.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		now = 2_200;
		await root.emit("message_end", assistantEnd(10));
		await root.runCommand("footer", "debug");

		const debug = root.notifications.at(-1);
		expect(debug).toContain("requests=1");
		expect(debug).toContain("avgTtft=200");
		expect(debug).toContain("lastTtft=200");
		expect(debug).toContain("lastTok/s=8.3");
		expect(root.requestRender).toHaveBeenCalledTimes(1);

		root.getFooter()?.dispose?.();
		await root.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	const reloadSnapshot = {
		metrics: {
			requestSentAt: 1_000, firstTokenAt: 1_100, curTtftMs: 100,
			lastTtftMs: 200, lastTtfbMs: null, lastTokPerSec: 20,
			totalOutput: 20, totalCallMs: 1_000, totalTtftMs: 200, ttftCount: 1,
			requests: 1, headersSeen: 1, responsesSeen: 0,
		},
		serviceTier: "priority",
	};

	it.each([
		["null", null],
		["array", []],
		["missing metrics", {}],
		["array metrics", { metrics: [] }],
		["missing required field", { metrics: { ...reloadSnapshot.metrics, requests: undefined } }],
		["null required field", { metrics: { ...reloadSnapshot.metrics, totalOutput: null } }],
		["missing nullable field", { metrics: { ...reloadSnapshot.metrics, lastTtfbMs: undefined } }],
		["NaN", { metrics: { ...reloadSnapshot.metrics, totalOutput: NaN } }],
		["infinity", { metrics: { ...reloadSnapshot.metrics, totalCallMs: Infinity } }],
		["negative", { metrics: { ...reloadSnapshot.metrics, headersSeen: -1 } }],
		["string", { metrics: { ...reloadSnapshot.metrics, curTtftMs: "100" } }],
		["invalid tier", { ...reloadSnapshot, serviceTier: 123 }],
	])("ignores a malformed latest reload snapshot: %s", async (label, data) => {
		const harness = createHarness(`corrupt-reload-${label}`, "tui", {
			entries: [
				{ type: "custom", customType: "statusline-footer:reload", data: reloadSnapshot },
				{ type: "custom", customType: "statusline-footer:reload", data },
			],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("headersSeen=0 responsesSeen=0 requests=0");
		expect(harness.notifications.at(-1)).toContain("avgTtft=- lastTtft=- lastTok/s=-");
		expect(harness.getFooter()!.render(240)[0]).not.toContain("FAST");
		harness.disposeFooter();
	});

	it("resets persisted in-flight fields when restoring completed metrics", async () => {
		let now = 2_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("reload-reset-markers", "tui", {
			entries: [{ type: "custom", customType: "statusline-footer:reload", data: reloadSnapshot }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		await harness.emit("message_end", assistantEnd(999));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=1");
		expect(harness.notifications.at(-1)).toContain("lastTtfb=- avgTtft=200 lastTtft=200 lastTok/s=20.0");

		now = 3_000;
		await harness.emit("message_start", { message: { role: "assistant" } });
		now = 3_200;
		await harness.emit("message_update", {
			type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fresh" },
		});
		now = 4_200;
		await harness.emit("message_end", assistantEnd(10));
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("requests=2");
		expect(harness.notifications.at(-1)).toContain("avgTtft=200 lastTtft=200 lastTok/s=8.3");
		expect(reloadSnapshot.metrics.requestSentAt).toBe(1_000);
		harness.disposeFooter();
	});

	it.each(["startup", "new", "resume", "fork"])("starts fresh rather than restoring stale entries on %s", async (reason) => {
		const harness = createHarness(`fresh-${reason}`, "tui", {
			entries: [{ type: "custom", customType: "statusline-footer:reload", data: reloadSnapshot }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason });
		await harness.runCommand("footer", "debug");
		expect(harness.notifications.at(-1)).toContain("headersSeen=0 responsesSeen=0 requests=0");
		expect(harness.getFooter()!.render(240)[0]).not.toContain("FAST");
		expect(harness.ctx.sessionManager.getEntries).not.toHaveBeenCalled();
		harness.disposeFooter();
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: reason === "startup" ? "quit" : reason });
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("never restores or persists print-session snapshots, even with the TUI session ID", async () => {
		const entries = [{ type: "custom", customType: "statusline-footer:reload", data: reloadSnapshot }];
		const root = createHarness("print-reload-isolation", "tui", { entries });
		const print = createHarness("print-reload-isolation", "print", { entries });
		for (const harness of [root, print]) {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { type: "session_start", reason: "reload" });
		}
		await print.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		expect(print.getFooter()).toBeUndefined();
		expect(print.ctx.sessionManager.getEntries).not.toHaveBeenCalled();
		expect(print.pi.appendEntry).not.toHaveBeenCalled();
		expect(entries).toHaveLength(1);
		await root.runCommand("footer", "debug");
		expect(root.notifications.at(-1)).toContain("requests=1");
		root.disposeFooter();
		await root.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(root.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("persists completed metrics across an actual module reload and drops in-flight timing", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const beforeReload = createHarness("reload-session", "tui");
		statuslineFooter(beforeReload.pi);
		await beforeReload.emit("session_start", { type: "session_start", reason: "startup" });

		await beforeReload.emit("before_provider_request", { payload: { service_tier: "priority" } });
		now = 5_000;
		await beforeReload.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 5_250;
		await beforeReload.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		now = 6_250;
		await beforeReload.emit("message_end", assistantEnd(20));
		now = 8_000;
		await beforeReload.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 8_600;
		await beforeReload.emit("message_update", {
			type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "unfinished" },
		});
		beforeReload.disposeFooter();
		await beforeReload.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		expect(beforeReload.pi.appendEntry).toHaveBeenCalledOnce();
		expect(beforeReload.entries[0]).toMatchObject({
			type: "custom", customType: "statusline-footer:reload", data: {
				serviceTier: "priority",
				metrics: {
					requestSentAt: 0, firstTokenAt: 0, curTtftMs: null,
					requests: 1, totalOutput: 20, totalCallMs: 1_250, lastTtftMs: 250,
				},
			},
		});
		await beforeReload.runCommand("footer", "debug");
		expect(beforeReload.notifications.at(-1)).toContain("metrics unavailable");

		vi.resetModules();
		const { default: reloadedFooter } = await import("../index.ts");
		const afterReload = createHarness("reload-session", "tui", {
			entries: [
				{ type: "custom", customType: "statusline-footer:reload", data: null },
				...structuredClone(beforeReload.entries),
				{ type: "custom", customType: "another-extension", data: {} },
			],
			branch: [], // The snapshot need not be on the currently selected branch.
		});
		reloadedFooter(afterReload.pi);
		await afterReload.emit("session_start", { type: "session_start", reason: "reload" });
		await afterReload.runCommand("footer", "debug");

		const debug = afterReload.notifications.at(-1);
		expect(debug).toContain("requests=1");
		expect(debug).toContain("avgTtft=250 lastTtft=250 lastTok/s=16.0");
		expect(afterReload.getFooter()!.render(240)[0]).toContain("FAST");
		expect(afterReload.ctx.sessionManager.getEntries).toHaveBeenCalledOnce();

		now = 10_000;
		await afterReload.emit("message_end", assistantEnd(999));
		await afterReload.runCommand("footer", "debug");
		expect(afterReload.notifications.at(-1)).toContain("requests=1");
		expect(afterReload.notifications.at(-1)).toContain("avgTtft=250 lastTtft=250 lastTok/s=16.0");
		now = 11_000;
		await afterReload.emit("message_start", { message: { role: "assistant" } });
		now = 11_150;
		await afterReload.emit("message_update", {
			type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fresh" },
		});
		now = 12_150;
		await afterReload.emit("message_end", assistantEnd(10));
		await afterReload.runCommand("footer", "debug");
		expect(afterReload.notifications.at(-1)).toContain("requests=2");
		expect(afterReload.notifications.at(-1)).toContain("avgTtft=200 lastTtft=150 lastTok/s=8.7");

		afterReload.disposeFooter();
		await afterReload.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(afterReload.pi.appendEntry).not.toHaveBeenCalled();
	});
});
