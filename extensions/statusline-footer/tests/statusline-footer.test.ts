import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import statuslineFooter, {
	alignRow,
	displayServiceTier,
	extractServiceTier,
	formatPath,
	gradientBar,
	hasNerdFonts,
	parseGitAheadBehind,
	parseGitShortstat,
	parseGitStatus,
	rainbow,
	thinkingCaps,
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

type HarnessOptions = {
	model?: { id: string; provider?: string; reasoning?: boolean; magpiePricing?: "estimate" | "unavailable"; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } } | null;
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
};

function createHarness(sessionId: string, mode: "tui" | "print", options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
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
	const theme = {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	};

	const ui = {
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
		cwd: options.cwd ?? process.cwd(),
		model: options.model === null
			? undefined
			: options.model ?? { id: "k3", provider: "moonshot", reasoning: true },
		thinkingLevel: options.thinkingLevel ?? "high",
		isIdle: () => options.isIdle ?? true,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
		getContextUsage: () => options.contextUsage === null
			? undefined
			: options.contextUsage ?? { percent: 42.5, tokens: 42_500, contextWindow: 100_000 },
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => "leaf",
			getBranch: () => options.branch ?? [],
			getEntries: vi.fn(() => entries),
		},
		ui,
	} as unknown as ExtensionContext;

	const pi = {
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
		expect(thinkingCaps("minimal")).toBe("MINIMAL");
		expect(thinkingCaps("medium")).toBe("MEDIUM");
		expect(thinkingCaps("xhigh")).toBe("XHIGH");
		expect(thinkingCaps("max")).toBe("MAX");
		const painted = rainbow("MAX");
		expect(painted).toContain("\x1b[38;2;");
		expect(painted.endsWith("\x1b[0m")).toBe(true);
		expect(visibleWidth(painted)).toBe(3);
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

	it("honors STATUSLINE_NERD_FONTS over terminal guesses", () => {
		const previous = process.env.STATUSLINE_NERD_FONTS;
		process.env.STATUSLINE_NERD_FONTS = "0";
		expect(hasNerdFonts()).toBe(false);
		process.env.STATUSLINE_NERD_FONTS = "1";
		expect(hasNerdFonts()).toBe(true);
		if (previous === undefined) delete process.env.STATUSLINE_NERD_FONTS;
		else process.env.STATUSLINE_NERD_FONTS = previous;
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

	it("renders four width-bounded full-mode lines with representative facts", async () => {
		const harness = createHarness("render-full-session", "tui", { branch });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		const lines = harness.getFooter()!.render(100);
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(lines[0]).toContain("k3");
		expect(lines[0]).toContain("HIGH");
		expect(lines[0]).toContain("42.5%");
		expect(lines[1]).toContain("─");
		expect(visibleWidth(lines[1]!)).toBe(100);
		expect(lines[2]).toContain("$1.35");
		expect(lines[2]).toContain("1.9k");
		expect(lines[2]).toContain("475");
		expect(lines[2]).toContain("950");
		expect(lines[2]).toContain("195 think");
		expect(lines[3]).toContain("main");
		expect(lines[3]).toContain("READY");
		expect(lines[3]).toContain("1 touched");
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
		expect(pending.getFooter()!.render(120)[3]).toContain("git …");
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
		expect(clean.getFooter()!.render(120)[3]).toContain("clean");
		clean.getFooter()?.dispose?.();

		statusOutput = "?? untracked.txt\n";
		const dirty = createHarness("git-dirty", "tui");
		statuslineFooter(dirty.pi);
		await dirty.emit("session_start", { type: "session_start", reason: "startup" });
		const dirtyLine = dirty.getFooter()!.render(120)[3]!;
		expect(dirtyLine).toContain("dirty");
		expect(dirtyLine).not.toContain("clean");
		dirty.getFooter()?.dispose?.();

		statusError = true;
		const unavailable = createHarness("git-unavailable", "tui");
		statuslineFooter(unavailable.pi);
		await unavailable.emit("session_start", { type: "session_start", reason: "startup" });
		const unavailableLine = unavailable.getFooter()!.render(120)[3]!;
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
		const totals = lines[2]!;
		expect(lines[2]).toContain("$1.12");
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
		const totals = harness.getFooter()!.render(240)[2]!;
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
		expect(lines[2]).toContain("$0.000");
		expect(lines[2]).not.toContain("think");
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

	it("keeps loop and generic statuses visible ahead of a long cwd in full mode", async () => {
		const harness = createHarness("full-loop-status", "tui", {
			cwd: `/tmp/${"深い階層/".repeat(30)}project`,
			keyedExtensionStatuses: { loop: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			for (const width of [55, 80, 120]) {
				const lines = harness.getFooter()!.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(lines[3]).toContain("↻ build · next 4m");
				expect(lines[3]!.split("↻ build · next 4m")).toHaveLength(2);
				expect(lines[3]).toContain("READY");
				expect(lines[3]).toContain("SYNC");
				expect(lines[3]).toContain("main");
				expect(lines[3]).not.toContain("project");
			}
			expect(harness.getFooter()!.render(240)[3]).toContain("/tmp/");
			harness.setStatus("loop", "↻ wait · next 4m");
			expect(harness.getFooter()!.render(80)[3]).toContain("↻ wait · next 4m");
		} finally {
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
			const priceLine = mode === "full" ? lines[2]! : lines[0]!;
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
		const line = harness.getFooter()!.render(240)[2]!;
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
		expect(harness.getFooter()!.render(240)[2]).toContain("$0.000");
		expect(harness.getFooter()!.render(240)[2]).not.toContain("price unavailable");
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
		const full = harness.getFooter()!.render(240)[2]!;
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
		expect(harness.getFooter()!.render(240)[2]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it.each(["input", "output", "cacheRead", "cacheWrite"] as const)("treats %s tokens with unavailable pricing as unpriced", async (counter) => {
		const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [counter]: 1 };
		const harness = createHarness(`pricing-${counter}-only`, "tui", {
			branch: [{ type: "compaction", usage: usage(0, "unavailable", tokens) }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[2]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it("keeps zero-token unavailable usage out of the missing-price count", async () => {
		const harness = createHarness("pricing-empty-usage", "tui", {
			branch: [{ type: "compaction", usage: usage(0, "unavailable", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[2]).toContain("$0.000");
		expect(harness.getFooter()!.render(240)[2]).not.toContain("price unavailable");
		harness.disposeFooter();
	});

	it("treats explicitly estimated native compaction usage as priced even at zero cost", async () => {
		const harness = createHarness("pricing-compaction-estimate", "tui", {
			branch: [{ type: "compaction", usage: usage(0, "estimate") }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[2]).toContain("~$0.000");
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
		const line = harness.getFooter()!.render(240)[2]!;
		expect(line).toContain(pricing === "unavailable" ? "price unavailable" : "~$0.250");
		harness.disposeFooter();
	});

	it("shows selected Magpie model's unavailable price before any usage", async () => {
		const harness = createHarness("pricing-current-empty", "tui", {
			model: { ...freeModel, id: "unpriced", provider: "magpie", magpiePricing: "unavailable" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240)[2]).toContain("price unavailable");
		await harness.runCommand("footer", "compact");
		expect(harness.getFooter()!.render(240)[0]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it("reads the current model on every render, even at the same branch leaf", async () => {
		const harness = createHarness("pricing-model-switch", "tui", { model: freeModel, branch: [assistant("other", 1)] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const full = () => harness.getFooter()!.render(240)[2]!;
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
				const priceLine = harness.getFooter()!.render(240)[mode === "full" ? 2 : 0]!;
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
		expect(harness.notifications.at(-1)).toContain("avgTtft=600 lastTtft=600 lastTok/s=10.0");
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
		expect(harness.notifications.at(-1)).toContain("avgTtft=200 lastTtft=200 lastTok/s=20.0");
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
		expect(debug).toContain("lastTok/s=10.0");

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
		expect(debug).toContain("lastTok/s=20.0");
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
		expect(debug).toContain("lastTok/s=10.0");
		expect(root.requestRender).toHaveBeenCalledTimes(1);

		root.getFooter()?.dispose?.();
		await root.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	const reloadSnapshot = {
		metrics: {
			requestSentAt: 1_000, firstTokenAt: 1_100, curTtftMs: 100,
			lastTtftMs: 200, lastTtfbMs: null, lastTokPerSec: 20,
			totalOutput: 20, totalStreamMs: 1_000, totalTtftMs: 200, ttftCount: 1,
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
		["infinity", { metrics: { ...reloadSnapshot.metrics, totalStreamMs: Infinity } }],
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
		expect(harness.notifications.at(-1)).toContain("avgTtft=200 lastTtft=200 lastTok/s=10.0");
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
					requests: 1, totalOutput: 20, totalStreamMs: 1_000, lastTtftMs: 250,
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
		expect(debug).toContain("avgTtft=250 lastTtft=250 lastTok/s=20.0");
		expect(afterReload.getFooter()!.render(240)[0]).toContain("FAST");
		expect(afterReload.ctx.sessionManager.getEntries).toHaveBeenCalledOnce();

		now = 10_000;
		await afterReload.emit("message_end", assistantEnd(999));
		await afterReload.runCommand("footer", "debug");
		expect(afterReload.notifications.at(-1)).toContain("requests=1");
		expect(afterReload.notifications.at(-1)).toContain("avgTtft=250 lastTtft=250 lastTok/s=20.0");
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
		expect(afterReload.notifications.at(-1)).toContain("avgTtft=200 lastTtft=150 lastTok/s=10.0");

		afterReload.disposeFooter();
		await afterReload.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(afterReload.pi.appendEntry).not.toHaveBeenCalled();
	});
});
