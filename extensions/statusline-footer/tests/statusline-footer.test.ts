import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PROCESS_STATUS_KEY, summarizeProcesses } from "../processes.ts";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWARM_BOARDS } from "../swarm-board.ts";
import statuslineFooter, {
	DESK_RANKS,
	FOOTER_TIERS,
	LAPTOP_RANKS,
	alignRow,
	chipInk,
	contrastRatio,
	detectLinkedWorktree,
	displayServiceTier,
	embedRightBorderTitle,
	extractServiceTier,
	formatPath,
	formatWorkspacePath,
	gradientBar,
	hasNerdFonts,
	isGenericWorkingStatus,
	parseGitAheadBehind,
	parseGitPorcelain,
	parseGitShortstat,
	parseGitStatus,
	pillTintSurface,
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

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
let testAgentDir = "";

beforeEach(() => {
	vi.mocked(execFile).mockReset();
	testAgentDir = mkdtempSync(path.join(os.tmpdir(), "statusline-footer-test-"));
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
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
	sessionName?: string;
	extensionStatuses?: string[];
	keyedExtensionStatuses?: Record<string, string>;
	isIdle?: boolean;
	hasPendingMessages?: boolean;
	events?: ExtensionAPI["events"];
	theme?: { fg: (token: string, text: string) => string; bg?: (token: string, text: string) => string; bold: (text: string) => string };
	settings?: unknown;
	custom?: (...args: any[]) => Promise<any>;
};

// /footer records command-usage telemetry; only the footer's own entries count as persisted state.
function persistedEntries(pi: ExtensionAPI): unknown[] {
	return vi.mocked(pi.appendEntry).mock.calls.filter(([customType]) => customType !== "pi-extensions.command");
}

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
		...(options.custom ? { custom: options.custom } : {}),
	};

	let isIdleState = options.isIdle ?? true;
	let pendingMessagesState = options.hasPendingMessages ?? false;
	let sessionNameState = options.sessionName;
	let contextUsageState = options.contextUsage;

	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: options.cwd ?? "/tmp/project",
		model: options.model === null
			? undefined
			: options.model ?? { id: "k3", provider: "moonshot", reasoning: true },
		thinkingLevel: options.thinkingLevel ?? "high",
		isIdle: () => isIdleState,
		hasPendingMessages: () => pendingMessagesState,
		getContextUsage: () => contextUsageState === null
			? undefined
			: contextUsageState ?? { percent: 42.5, tokens: 42_500, contextWindow: 100_000 },
		modelRegistry: {
			getAll: () => options.registryModels ?? (ctx.model ? [ctx.model] : []),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => sessionNameState,
			getLeafId: () => options.branch?.at(-1)?.id ?? "leaf",
			getBranch: () => options.branch ?? [],
			getEntries: vi.fn(() => entries),
		},
		ui,
	} as unknown as ExtensionContext;

	const pi = {
		events,
		...(options.settings !== undefined ? { getSettings: () => options.settings } : {}),
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
		setIsIdle: (idle: boolean) => { isIdleState = idle; },
		setPendingMessages: (pending: boolean) => { pendingMessagesState = pending; },
		setSessionName: (name: string | undefined) => { sessionNameState = name; },
		setContextUsage: (usage: HarnessOptions["contextUsage"]) => { contextUsageState = usage; },
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
	if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
	if (testAgentDir) {
		rmSync(testAgentDir, { recursive: true, force: true });
		testAgentDir = "";
	}
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
		expect(gradientBar(40, 8)).toContain("━");
		expect(gradientBar(40, 8)).toContain("─");
	});

	it("uses normal text for XHIGH and a rainbow for MAX", () => {
		const theme = { fg: (token: string, text: string) => `<${token}>${text}` } as unknown as Parameters<typeof renderThinking>[0];
		expect(renderThinking(theme, "max")).toBe(rainbow("MAX"));
		expect(renderThinking(theme, "xhigh")).toBe("<text>XHIGH");
		expect(renderThinking(theme, "medium")).toBe("<success>MEDIUM");
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
		expect(renderStatus(theme, "↻ build · paused", "goal")).toBe(`<${statusHue(theme, "goal")}>↻ build<dim> · <warning>paused`);
		expect(renderStatus(theme, "\x1b[32mpainted\x1b[0m", "x")).toBe("\x1b[32mpainted\x1b[0m");
		expect(new Set(["autoresearch", "herder", "goal", PROCESS_STATUS_KEY].map(key => statusHue(theme, key))).size).toBe(4);
		expect(statusHue(theme, "custom")).toBe(statusHue(theme, "custom"));
		// Explicit slots keep existing colors when a new status takes priority.
		const palette = statusPalette(theme);
		expect(statusHue(theme, "language")).toBe(palette[6 % palette.length]);
		expect(statusHue(theme, "spokesman")).toBe(palette[7 % palette.length]);
		const slots = { autoresearch: 0, herder: 1, goal: 2, [PROCESS_STATUS_KEY]: 3, subagents: 4, language: 6, spokesman: 7, swarm: 8, selfdrive: 10, representative: 11, "magpie-quota": 12 };
		for (const [key, slot] of Object.entries(slots)) {
			expect(statusHue(theme, key)).toBe(palette[slot % palette.length]);
		}
		for (const state of ["awaiting", "paused"]) {
			expect(renderStatus(theme, `quota ${state} · retry in 2h 10m · Nov 12, 14:30`, "magpie-quota", true))
				.toBe(`<${statusHue(theme, "magpie-quota")}>\u{F0954} <warning>quota ${state}<dim> · <muted>retry in 2h 10m<dim> · <muted>Nov 12<dim>, <muted>14:30`);
		}
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
	it("uppercases native service tiers and suppresses common defaults", () => {
		expect(extractServiceTier({ service_tier: "priority" })).toBe("priority");
		expect(extractServiceTier({ serviceTier: "flex" })).toBe("flex");
		for (const tier of ["priority", "FAST", "flex", "custom_tier"]) {
			expect(displayServiceTier(` ${tier} `)).toBe(tier.toUpperCase());
		}
		for (const tier of [undefined, "", "standard", "default", "auto", "standard_only"]) {
			expect(displayServiceTier(tier)).toBeUndefined();
		}
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
				// Full mode is the phone's single plain row at 40 columns: no bar and no token counts.
				expect(narrow).not.toContain("100k");
				if (mode === "full") expect(narrow).not.toMatch(/[━╸─]/);
				else expect([...narrow].filter((char) => char === "━" || char === "╸" || char === "─" || char === "▕").length).toBeLessThan(10);
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
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.mocked(execFile).mockImplementation(((_file: unknown, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
			if (args.includes("status")) cb(null, "");
			else if (args.includes("--shortstat")) cb(null, "");
			else cb(null, "0\t0\n");
		}) as unknown as typeof execFile);
		const harness = createHarness("nerd-font-codepoints", "tui", {
			branch: [
				{ id: "c1", type: "compaction", summary: "compact", firstKeptEntryId: "c1", tokensBefore: 50_000 },
				{ type: "message", message: {
					role: "assistant",
					usage: { input: 1, output: 2, cacheRead: 3, cost: { total: 0.01 } },
					content: [{ type: "toolCall", name: "edit", arguments: { path: "example.ts" } }],
				} },
			],
		});
		try {
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			now = 1_000;
			await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
			now = 1_200;
			await harness.emit("message_update", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
			});
			now = 1_500;
			await harness.emit("message_end", assistantEnd(20));
			const rendered = harness.getFooter()!.render(240).join("\n");
			for (const codepoint of [0xF0615, 0xF0954, 0xF0368, 0xF005E, 0xF0046, 0xF140B,
				0xF01C1, 0xF051B, 0xF04C5, 0xF05B7, 0xF0133, 0xF062C, 0xF03EB, 0xF0770]) {
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
				content: [{ type: "toolCall", name: "edit", arguments: { path: "src/example.ts" } }],
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

		// A laptop: the bar, the READY status, and one essentials row.
		const lines = harness.getFooter()!.render(100);
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(lines[0]).toContain("k3");
		expect(lines[0]).toContain("HIGH");
		expect(lines[0]).toContain("42.5%");
		// The rows hang from the bar on the rail.
		expect(lines[1]!.startsWith(" ├ ")).toBe(true);
		expect(lines[1]).toContain("READY");
		expect(lines[2]!.startsWith(" ╰ ")).toBe(true);
		// The failed tool result stays; the cache rate is the first to give way.
		for (const fact of ["main", "$1.35", "1 (100.0%)", "/tmp/project"]) expect(lines[2]).toContain(fact);
		for (const diagnostic of ["195 think", "1 edited", "/turn", "READY"]) expect(lines[2]).not.toContain(diagnostic);
		// A desk folds a single routine status into the workspace row to stay stably 3 rows.
		const wide = harness.getFooter()!.render(200);
		expect(wide).toHaveLength(3);
		for (const fact of ["$1.35", "1.9k", "475", "950", "195 think"]) expect(wide.at(-2)).toContain(fact);
		expect(wide.at(-1)).toContain("main");
		expect(wide.at(-1)).toContain("1 edited");
		expect(wide.at(-1)).toContain("READY");
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
		expect(pending.getFooter()!.render(120).at(-1)).toContain("git …");
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
		expect(clean.getFooter()!.render(120).at(-1)).toContain("clean");
		clean.getFooter()?.dispose?.();

		statusOutput = "?? untracked.txt\n";
		const dirty = createHarness("git-dirty", "tui");
		statuslineFooter(dirty.pi);
		await dirty.emit("session_start", { type: "session_start", reason: "startup" });
		const dirtyLine = dirty.getFooter()!.render(120).at(-1)!;
		expect(dirtyLine).toContain("?1");
		expect(dirtyLine).not.toContain("clean");
		dirty.getFooter()?.dispose?.();

		statusError = true;
		const unavailable = createHarness("git-unavailable", "tui");
		statuslineFooter(unavailable.pi);
		await unavailable.emit("session_start", { type: "session_start", reason: "startup" });
		const unavailableLine = unavailable.getFooter()!.render(120).at(-1)!;
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
		const totals = lines.at(-2)!;
		expect(lines.at(-2)).toContain("$1.12");
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
		const totals = harness.getFooter()!.render(240).at(-2)!;
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
		expect(lines.at(-2)).toContain("$0.000");
		expect(lines.at(-2)).not.toContain("think");
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
		expect(full).toHaveLength(3);
		for (const line of full) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		harness.getFooter()?.dispose?.();
	});

	it.each(["full", "compact"])("renders and clears a plain goal in %s mode", async (mode) => {
		const harness = createHarness(`plain-goal-${mode}`, "tui", { extensionStatuses: [] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			const baseline = harness.getFooter()!.render(160);
			harness.setStatus("goal", "goal: finish the migration");
			const lines = harness.getFooter()!.render(160);
			expect(lines[mode === "full" ? 1 : 0]).toContain("goal: finish the migration");
			if (mode === "full") expect(lines[1]).toContain("\u{F0E6F}");
			for (let width = 0; width <= 80; width++) {
				const narrow = harness.getFooter()!.render(width);
				for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 24) expect(narrow[0]).toContain("42.5%");
			}
			harness.setStatus("goal");
			expect(harness.getFooter()!.render(160)).toEqual(baseline);
		} finally { harness.disposeFooter(); }
	});

	it.each(["full", "compact"])("fits goal with Herder, research and quota in %s mode", async (mode) => {
		const harness = createHarness(`goal-concurrent-${mode}`, "tui", { extensionStatuses: [], keyedExtensionStatuses: {
			goal: "goal: migrate the entire application safely", herder: "herder: T2 integrate",
			autoresearch: "research · measuring · iteration 12", "magpie-quota": "quota checking",
		} });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			const row = mode === "full" ? 1 : 0;
			const wide = harness.getFooter()!.render(160)[row]!;
			for (const text of ["goal: migrate", "herder: T2 integrate", "research · measuring", "quota checking"]) expect(wide).toContain(text);
			const ordinary = harness.getFooter()!.render(80)[row]!;
			expect(ordinary).toContain("herder: T2 integrate");
			expect(ordinary).toContain("goal: migrate");
			// Full mode's narrowest activity row is a laptop's.
			const narrow = mode === "full" ? 72 : 60;
			harness.setStatus("goal", "goal: migration blocked · needs input");
			const attention = harness.getFooter()!.render(narrow)[row]!;
			expect(attention).toContain("blocked");
			harness.setStatus("goal", "goal: migration paused · needs input");
			expect(harness.getFooter()!.render(narrow)[row]).toContain("paused");
			harness.setStatus("goal");
			expect(harness.getFooter()!.render(160).join("\n")).not.toContain("goal:");
		} finally { harness.disposeFooter(); }
	});

	it("keeps an abbreviated goal beside routine research without Herder", async () => {
		const harness = createHarness("goal-research", "tui", { extensionStatuses: [], keyedExtensionStatuses: {
			goal: "goal: migrate the entire application safely", autoresearch: "research · measuring · iteration 12",
		} });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			const line = harness.getFooter()!.render(80)[0]!;
			expect(line).toContain("goal: migrate");
			expect(line).toContain("research · measuring");
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		} finally { harness.disposeFooter(); }
	});

	it("shows changing goal status in compact mode only while identity and percent fit", async () => {
		const harness = createHarness("compact-goal-status", "tui", {
			keyedExtensionStatuses: { goal: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			for (const width of [120, 60, 40, 39, 38, 37, 30, 24, 1]) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 39) expect(line).toContain("↻ build · next 4m");
				else if (width === 38) expect(line.replace(/\x1b\[[0-9;]*m/g, "")).toContain("↻ build · next …");
				else expect(line).not.toContain("↻ build");
				if (width >= 24) {
					expect(line).toContain("k3");
					expect(line).toContain("42.5%");
				}
				expect(line).not.toContain("SYNC");
			}
			harness.setStatus("goal", "↻ paused");
			expect(harness.getFooter()!.render(60)[0]).toContain("↻ paused");
			expect(harness.getFooter()!.render(60)[0]).not.toContain("↻ build");
			harness.setStatus("goal");
			expect(harness.getFooter()!.render(120)[0]).not.toContain("↻ paused");
			expect(harness.getFooter()!.render(120)[0]).toContain("42.5%");
		} finally {
			harness.disposeFooter();
		}
	});

	it("fits wide Unicode goal status without clipping model or context", async () => {
		const harness = createHarness("compact-unicode-goal", "tui", {
			model: { id: "模型模型", reasoning: true },
			keyedExtensionStatuses: { goal: "↻ 構築 · 次 4m" },
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

	it("gives goal and generic statuses their own row beside a long cwd in full mode", async () => {
		const harness = createHarness("full-goal-status", "tui", {
			cwd: `/tmp/${"深い階層/".repeat(30)}project`,
			keyedExtensionStatuses: { goal: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			for (const width of [72, 80, 120]) {
				const lines = harness.getFooter()!.render(width);
				expect(lines).toHaveLength(3);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(lines.at(-1)).toContain("main");
				expect(lines.at(-1)).toContain("/…/");
				expect(lines.at(-1)).toContain("project");
				expect(lines.at(-1)).not.toContain("↻");
				expect(lines[1]).toContain("↻ build · next 4m");
				expect(lines[1]!.split("↻ build · next 4m")).toHaveLength(2);
				expect(lines[1]).toContain("READY");
				expect(lines[1]).toContain("SYNC");
			}
			harness.setStatus("goal", "↻ wait · next 4m");
			expect(harness.getFooter()!.render(80)[1]).toContain("↻ wait · next 4m");
			for (const key of ["goal", "other", "READY"]) harness.setStatus(key);
			expect(harness.getFooter()!.render(80)).toHaveLength(2);
		} finally {
			harness.disposeFooter();
		}
	});

	it("orders full-mode statuses research, Herder, goal, then the rest", async () => {
		const harness = createHarness("full-herder-status", "tui", {
			keyedExtensionStatuses: { other: "SYNC", goal: "goal build", herder: "herder: T2 integrate · 3/5 tasks", autoresearch: "research 2/5" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const line = harness.getFooter()!.render(200)[1]!;
			expect(line.split("herder: T2 integrate · 3/5 tasks")).toHaveLength(2);
			const order = ["research 2/5", "herder: T2", "goal build", "SYNC"].map(text => line.indexOf(text));
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
			for (const width of [72, 80, 120]) {
				const lines = harness.getFooter()!.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(lines[1]).toContain("herder: T2 integrate · 3/5 tasks");
				expect(lines.at(-1)).toContain("main");
				expect(lines.at(-1)).toContain("/…/");
				expect(lines.at(-1)).toContain("project");
			}
			harness.setStatus("herder");
			expect(harness.getFooter()!.render(120)[1]).not.toContain("herder:");
		} finally {
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("fits Herder alongside concurrent workflows in compact mode (Nerd Fonts %s)", async (nerdFonts) => {
		const research = "research · run 3/20 · measured · Compile 182 ms (-14.554%)";
		const quota = "quota · checking reset time";
		const herder = "herder: T2 integrate · 3/5 tasks";
		const harness = createHarness(`compact-herder-status-${nerdFonts}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: { "magpie-quota": quota, autoresearch: research, herder },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			const wide = harness.getFooter()!.render(160)[0]!;
			for (const text of [quota, research, herder]) expect(wide).toContain(text);
			const ordinary = harness.getFooter()!.render(80)[0]!;
			expect(ordinary).toContain(quota);
			expect(ordinary).toContain("herder: T2 integrate");
			expect(ordinary).not.toContain("3/5 tasks");
			expect(ordinary).not.toContain(research);
			const narrow = harness.getFooter()!.render(50)[0]!;
			expect(narrow).toContain("herder: T2 integrate");
			expect(narrow).not.toContain(quota);
			for (let width = 0; width <= 160; width++) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				if (width >= 24) {
					expect(line, `${width}`).toContain("k3");
					expect(line, `${width}`).toContain("42.5%");
				}
			}
			const operation = "herder: T2 構築 · verify changes";
			harness.setStatus("herder", `${operation} · 3/5 tasks`);
			const shortened = Array.from({ length: 120 }, (_, width) => harness.getFooter()!.render(width + 1)[0]!)
				.find(line => line.includes(operation) && !line.includes("3/5 tasks"));
			expect(shortened).toBeDefined();
			harness.setStatus("herder", herder);
			// With quota cleared, both current operations fit at 80 columns even if the metric does not.
			harness.setStatus("magpie-quota");
			const twoWorkflows = harness.getFooter()!.render(80)[0]!;
			expect(twoWorkflows).toContain("research · run 3/20");
			expect(twoWorkflows).toContain("herder: T2 integrate");
			expect(twoWorkflows).not.toContain("Compile 182 ms");
			expect(harness.getFooter()!.render(160)[0]).toContain(research);
			// Once Herder clears, compact mode retains its established single-workflow order.
			harness.setStatus("magpie-quota", quota);
			harness.setStatus("herder");
			let line = harness.getFooter()!.render(160)[0]!;
			expect(line).toContain(quota);
			expect(line).not.toContain(research);
			harness.setStatus("magpie-quota");
			line = harness.getFooter()!.render(160)[0]!;
			expect(line).toContain(research);
			expect(line).not.toContain("herder:");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("keeps Herder ahead of routine full-row activity but below attention and problems (Nerd Fonts %s)", async (nerdFonts) => {
		const harness = createHarness(`full-herder-priority-${nerdFonts}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: {
				autoresearch: "research · run 3/20 · measured · Compile 182 ms",
				herder: "herder: T2 integrate · 3/5 tasks",
				goal: "↻ build · next 4m", representative: "📣 rep #dev", "relay-rooms": "#ops",
			},
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			for (const width of [72, 80, 160]) {
				const lines = harness.getFooter()!.render(width);
				for (const line of lines) expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				expect(lines[0], `${width}`).toContain("k3");
				expect(lines[0], `${width}`).toContain("42.5%");
				expect(lines[1], `${width}`).toContain("herder: T2 integrate · 3/5 tasks");
			}
			const narrow = () => harness.getFooter()!.render(72)[1]!;
			expect(narrow()).not.toContain("rep #dev");
			expect(narrow()).not.toContain("research");
			harness.setStatus("magpie-quota", "quota paused · resume manually");
			expect(narrow()).toContain("quota paused · resume manually");
			expect(narrow()).not.toContain("herder:");
			// Too long to share a laptop's row with the quota wait.
			harness.setStatus("custom", "build blocked · waiting on the release lock");
			expect(narrow()).toContain("build blocked · waiting on the release lock");
			expect(narrow()).not.toContain("quota paused");
			harness.setStatus("custom");
			harness.setStatus("magpie-quota");
			expect(narrow()).toContain("herder: T2 integrate");
			harness.setStatus("herder");
			expect(narrow()).toContain("↻ build");
			expect(narrow()).not.toContain("research");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("keeps compact attention and problem statuses ahead of routine Herder (Nerd Fonts %s)", async (nerdFonts) => {
		const harness = createHarness(`compact-herder-severity-${nerdFonts}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: {
				"magpie-quota": "quota paused · resume manually", autoresearch: "research · run 3/20",
				herder: "herder: T2 integrate · 3/5 tasks", goal: "↻ build",
			},
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			const wide = harness.getFooter()!.render(160)[0]!;
			for (const text of ["quota paused · resume manually", "research · run 3/20", "herder: T2 integrate", "↻ build"]) expect(wide).toContain(text);
			const ordinary = harness.getFooter()!.render(80)[0]!;
			expect(ordinary).toContain("quota paused · resume manually");
			expect(ordinary).toContain("herder: T2 integrate");
			const narrow = () => harness.getFooter()!.render(50)[0]!;
			const detailed = harness.getFooter()!.render(53)[0]!;
			expect(detailed).toContain("quota paused · resume manually");
			expect(detailed).not.toContain("herder:");
			const abbreviated = narrow();
			expect(abbreviated).toContain("quota paused");
			expect(abbreviated).not.toMatch(/resume manually|herder:/);
			harness.setStatus("autoresearch", "research · paused · state error");
			const problem = harness.getFooter()!.render(60)[0]!;
			expect(problem).toContain("research · paused · state error");
			expect(problem).not.toContain("quota paused");
			expect(problem).not.toContain("herder:");
			harness.setStatus("autoresearch");
			harness.setStatus("herder", "herder: verified blocked · 3/5 tasks");
			const blocked = harness.getFooter()!.render(55)[0]!;
			expect(blocked).toContain("herder: verified blocked");
			expect(blocked).not.toContain("quota paused");
			harness.setStatus("magpie-quota");
			harness.setStatus("herder", "herder: T2 integrate · 3/5 tasks");
			harness.setStatus(PROCESS_STATUS_KEY, "bg 1 failed");
			expect(narrow()).toContain("bg 1 failed");
			expect(narrow()).not.toContain("herder:");
			harness.setStatus(PROCESS_STATUS_KEY, "bg 1 running");
			expect(narrow()).toContain("herder: T2 integrate");
			expect(narrow()).not.toContain("bg 1 running");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("keeps routine Herder calm beside a warning and leaves publisher ANSI intact", async () => {
		const theme = { fg: (token: string, text: string) => `<${token}>${text}`, bold: (text: string) => text };
		const harness = createHarness("compact-herder-colors", "tui", {
			extensionStatuses: [], theme,
			keyedExtensionStatuses: { "magpie-quota": "quota paused · resume manually", herder: "herder: T2 integrate · 3/5 tasks" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			const wide = harness.getFooter()!.render(240)[0]!;
			expect(wide).toContain("<warning>quota paused");
			expect(wide).toContain(`<${statusHue(theme as unknown as Parameters<typeof statusHue>[0], "herder")}>herder: T2 integrate`);
			expect(wide).not.toContain("<warning>herder:");
			const styled = "\x1b[36mherder: T2 inspect · add tests · 3/5 tasks\x1b[0m";
			harness.setStatus("herder", styled);
			expect(harness.getFooter()!.render(240)[0]).toContain(styled);
			for (let width = 24; width <= 160; width++) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				if (line.includes("herder:")) expect(line, `${width}`).toContain("\x1b[36mherder:");
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("abbreviates long and multi-segment Herder statuses while retaining later severity (Nerd Fonts %s)", async (nerdFonts) => {
		const operation = "herder: T2 verify integration across all modules · 3/5 tasks";
		const multi = "herder: T1 implement worker one · T2 fix worker two · +1 steps · checking unit · phase: T2: fix · log: waiting · 0/3 tasks";
		const harness = createHarness(`herder-long-${nerdFonts}`, "tui", {
			model: { id: "claude-opus-4-6" }, extensionStatuses: [],
			keyedExtensionStatuses: { swarm: "🐝 swarm", herder: operation },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			for (const status of [operation, multi, `\x1b[36m${multi}\x1b[0m`, "herder: T2 構築と検証 across all modules · 3/5 tasks"]) {
				harness.setStatus("herder", status);
				const line = harness.getFooter()!.render(80)[0]!;
				expect(line).toContain("herder: T");
				expect(line).toContain(nerdFonts === "1" ? "\u{F024B} swarm" : "swarm");
				expect(line).not.toContain("🐝");
				expect(line).toContain("claude-opus-4-6");
				expect(line).toContain("42.5%");
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
				expect(harness.getFooter()!.render(240)[0]).toContain(status);
			}
			harness.setStatus("herder", `${multi} · state failed`);
			const failed = harness.getFooter()!.render(80)[0]!;
			expect(failed).toContain("herder: T1");
			expect(failed).toContain("failed");
			harness.setStatus("herder", `${multi} · paused`);
			expect(harness.getFooter()!.render(80)[0]).toContain("paused");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("keeps fitting errors visible and ranks colon ANSI severity (Nerd Fonts %s)", async (nerdFonts) => {
		const quota = "quota \x1b[38:2::255:0:0mfailed\x1b[0m";
		const harness = createHarness(`herder-errors-${nerdFonts}`, "tui", {
			extensionStatuses: [], keyedExtensionStatuses: {
				"magpie-quota": quota, herder: "herder: T2 test operation across all modules and integration suites failed · 3/5 tasks",
			},
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			// Herder's problem cannot fit a laptop's narrowest activity row; the quota's can.
			const full = harness.getFooter()!.render(72)[1]!;
			expect(full).toContain(quota);
			expect(full).not.toContain("herder:");
			expect(visibleWidth(full)).toBeLessThanOrEqual(72);
			harness.setStatus("herder", "herder: T2 integrate · 3/5 tasks");
			await harness.runCommand("footer", "compact");
			const compact = harness.getFooter()!.render(45)[0]!;
			expect(compact).toContain(quota);
			expect(compact).not.toContain("herder:");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("keeps later fitting problems and lone Herder severity visible in full mode (Nerd Fonts %s)", async (nerdFonts) => {
		// Longer than a laptop's narrowest activity row.
		const operation = "herder: T2 test operation across all modules and integration suites";
		const herder = `${operation} failed · 3/5 tasks`;
		const harness = createHarness(`full-herder-later-${nerdFonts}`, "tui", {
			extensionStatuses: [], keyedExtensionStatuses: { herder },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			for (const [key, text] of [["custom", "build failed"], ["goal", "goal failed"], ["representative", "rep failed"]]) {
				harness.setStatus(key!, text!);
				const line = harness.getFooter()!.render(72)[1]!;
				expect(line).toContain(text);
				expect(line).not.toContain("herder:");
				expect(visibleWidth(line)).toBeLessThanOrEqual(72);
				harness.setStatus(key!);
			}
			for (const marker of ["failed", "awaiting"]) {
				harness.setStatus("herder", `${operation} ${marker} · 3/5 tasks`);
				const line = harness.getFooter()!.render(72)[1]!;
				expect(line).toContain("herder:");
				expect(line).toContain(marker);
				expect(visibleWidth(line)).toBeLessThanOrEqual(72);
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("strips leading colons from severity markers in detail, compact, and phone tiers", async () => {
		const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
		const cases = [
			{
				key: "herder",
				long: "herder: T2 test operation across all modules and integration suites · herder:blocked",
				short: "herder:blocked",
				marker: "blocked",
				phone: "herder blocked",
			},
			{
				key: "goal",
				long: "goal: migrate the entire application across all modules and suites · goal:paused",
				short: "goal:paused",
				marker: "paused",
				phone: "goal paused",
			},
		] as const;

		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const harness = createHarness("colon-severity-markers", "tui", {
			model: { id: "claude-opus-4-6" },
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			for (const { key, long, short, marker, phone } of cases) {
				await harness.runCommand("footer", "full");
				harness.setStatus(key, long);
				const detail = harness.getFooter()!.render(72)[1]!;
				expect(strip(detail)).toContain(`… ${marker}`);
				expect(strip(detail)).not.toContain(`:${marker}`);
				expect(visibleWidth(detail)).toBeLessThanOrEqual(72);

				harness.setStatus(key, short);
				const phoneRow = strip(harness.getFooter()!.render(FOOTER_TIERS.phoneMax)[0]!);
				expect(phoneRow).toContain(phone);
				expect(phoneRow).not.toContain(`:${marker}`);

				await harness.runCommand("footer", "compact");
				harness.setStatus(key, long);
				const compact = harness.getFooter()!.render(80)[0]!;
				expect(strip(compact)).toContain(`… ${marker}`);
				expect(strip(compact)).not.toContain(`:${marker}`);
				expect(visibleWidth(compact)).toBeLessThanOrEqual(80);
				harness.setStatus(key);
			}

			await harness.runCommand("footer", "compact");
			harness.setStatus("herder", "herder: T2 integrate");
			harness.setStatus("magpie-quota", "quota:awaiting · retry in 2h 10m · Nov 12, 14:30");
			const quotaFallback = harness.getFooter()!.render(55)[0]!;
			expect(strip(quotaFallback)).toContain("quota awaiting");
			expect(strip(quotaFallback)).not.toContain("quota :awaiting");
			expect(visibleWidth(quotaFallback)).toBeLessThanOrEqual(55);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("restores the exact %s layout after Herder clears", async (mode) => {
		const statuses = {
			"magpie-quota": "quota · checking reset time", autoresearch: "research · run 3/20", subagents: "2 running agents",
			language: "English", representative: "📣 rep #dev", "relay-rooms": "#dev #ops",
		};
		const start = async (id: string, withHerder: boolean) => {
			const harness = createHarness(id, "tui", {
				extensionStatuses: [], keyedExtensionStatuses: { ...statuses, ...(withHerder ? { herder: "herder: T2 integrate · 3/5 tasks" } : {}) },
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			harness.setStatus(PROCESS_STATUS_KEY, "bg 1 running");
			return harness;
		};
		const harness = await start(`herder00-clear-${mode}`, true);
		const baseline = await start(`herder00-absent-${mode}`, false);
		try {
			harness.setStatus("herder");
			for (const nerdFonts of ["0", "1"]) {
				vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
				for (const width of [24, 40, 60, 80, 120, 160, 240]) {
					expect(harness.getFooter()!.render(width), `${nerdFonts} at ${width}`).toEqual(baseline.getFooter()!.render(width));
				}
			}
			if (mode === "compact") {
				const wide = harness.getFooter()!.render(240)[0]!;
				expect(wide).toContain(statuses["magpie-quota"]);
				expect(wide).toContain("bg 1 running");
				expect(wide).not.toContain(statuses.autoresearch);
				expect(wide).not.toContain(statuses.subagents);
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
			baseline.disposeFooter();
		}
	});

	it.each(["full", "compact"])("prioritizes Magpie quota waits and restores workflows in %s mode", async (mode) => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
		const workflows = [
			["autoresearch", "research 2/5"], ["herder", "herder: T2 integrate"], ["goal", "↻ build"],
		] as const;
		const harness = createHarness(`quota-priority-${mode}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: Object.fromEntries([...workflows].reverse()),
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			const summaryRow = mode === "full" ? 1 : 0;
			const original = harness.getFooter()!.render(240)[summaryRow]!;
			for (const status of [
				"quota awaiting · checking availability",
				"quota awaiting · retry in 2h 10m · Nov 12, 14:30",
				"quota awaiting · retry in 2h 9m · Nov 12, 14:30",
				"quota paused · automatic continuation unavailable",
			]) {
				harness.ctx.ui.setStatus("magpie-quota", status);
				const lines = harness.getFooter()!.render(240);
				const summary = lines[summaryRow]!;
				expect(lines.join("\n").split("quota ")).toHaveLength(2);
				expect(summary).toContain(status);
				if (mode === "full") {
					expect(lines[0]).not.toContain("quota");
					expect(summary.split("\u{F0954}")).toHaveLength(2);
					expect(summary).not.toContain("\u{F0431}");
					const order = [status, ...workflows.map(([, text]) => text)].map(text => summary.indexOf(text));
					expect(order.every(index => index >= 0)).toBe(true);
					expect(order).toEqual([...order].sort((a, b) => a - b));
				} else {
					expect(summary).not.toContain("\u{F0954}");
					for (const [, text] of workflows) expect(summary).toContain(text);
				}
			}
			harness.ctx.ui.setStatus("magpie-quota", undefined);
			expect(harness.getFooter()!.render(240)[summaryRow]).toBe(original);
			for (const [key, text] of workflows) {
				const rendered = harness.getFooter()!.render(240);
				const summary = mode === "full" ? (rendered.length === 4 ? rendered[1]! : rendered.at(-1)!) : rendered[0]!;
				expect(summary).toContain(text);
				harness.ctx.ui.setStatus(key, undefined);
			}
			expect(harness.getFooter()!.render(240)).toHaveLength(mode === "full" ? 3 : 1);
		} finally {
			harness.disposeFooter();
			vi.unstubAllEnvs();
		}
	});

	it.each(["full", "compact"])("preserves model, context, and width with a quota countdown in %s mode", async (mode) => {
		const status = "quota awaiting · retry in 2h 10m · Nov 12, 14:30";
		for (const nerdFonts of ["0", "1"]) {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			const harness = createHarness(`quota-width-${mode}-${nerdFonts}`, "tui", {
				model: { id: "gpt-5.4", provider: "magpie", reasoning: true, magpiePricing: "estimate" },
				extensionStatuses: [],
				keyedExtensionStatuses: {
					herder: "herder: T2 integrate", autoresearch: "research 2/5", goal: "↻ build", "magpie-quota": status,
				},
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			try {
				for (let width = 0; width <= 160; width++) {
					const lines = harness.getFooter()!.render(width);
					for (const line of lines) expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
					if (width >= 24) {
						expect(lines[0], `${width}`).toContain("gpt-5.4");
						expect(lines[0], `${width}`).toContain("42.5%");
					}
					if (mode === "compact" && lines[0]!.includes("quota")) expect(lines[0], `${width}`).toContain("awaiting");
				}
				// Full mode's narrowest activity row is a laptop's.
				const narrow = harness.getFooter()!.render(mode === "full" ? 72 : 60)[mode === "full" ? 1 : 0]!;
				if (mode === "full") {
					expect(narrow).toContain(status);
					for (const text of ["research 2/5", "herder: T2 integrate", "↻ build"]) expect(narrow).not.toContain(text);
				} else {
					// Keep the quota state visible even when its full countdown cannot fit.
					expect(narrow).toContain("quota awaiting");
				}
				const wide = harness.getFooter()!.render(160)[mode === "full" ? 1 : 0]!;
				expect(wide).toContain(status);
				expect(wide).toContain("herder: T2 integrate");
			} finally {
				harness.disposeFooter();
				vi.unstubAllEnvs();
			}
		}
	});

	it.each(["0", "1"])("keeps compact quota severity ahead of routine work with styled Unicode text (Nerd Fonts %s)", async (nerdFonts) => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
		const harness = createHarness(`quota-marker-${nerdFonts}`, "tui", { extensionStatuses: [], keyedExtensionStatuses: {
			herder: "herder: T2 integrate", goal: "goal: migrate the application", autoresearch: "research · measuring",
		} });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			for (const marker of ["awaiting", "paused", "failed", "blocked"]) {
				const status = `\x1b[36mquota 配額 ${marker} · retry after the next availability window\x1b[0m`;
				harness.setStatus("magpie-quota", status);
				const narrow = harness.getFooter()!.render(60)[0]!;
				expect(narrow).toContain(`quota ${marker}`);
				expect(visibleWidth(narrow)).toBeLessThanOrEqual(60);
				expect(narrow).toContain("42.5%");
				expect(harness.getFooter()!.render(240)[0]).toContain(status);
			}
		} finally { harness.disposeFooter(); vi.unstubAllEnvs(); }
	});

	it.each(["full", "compact"])("shows the language in the %s bar and never on a status row", async (mode) => {
		const harness = createHarness(`language-bar-${mode}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: { language: "English" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		const rows = mode === "full" ? 2 : 1;
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
			keyedExtensionStatuses: { language: "English", goal: "↻ build · next 4m", other: "SYNC" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const lines = harness.getFooter()!.render(120);
			expect(lines).toHaveLength(3);
			expect(lines[0]).toContain("English");
			for (const status of ["↻ build · next 4m", "READY", "SYNC"]) {
				expect(lines[0]).not.toContain(status);
				expect(lines[1]).toContain(status);
			}
			expect(lines[1]).not.toContain("English");
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
			const seen = { languageWithBoth: false, bothWithoutLanguage: false, herderWithoutProcess: false };
			for (let width = 160; width >= 1; width--) {
				const line = harness.getFooter()!.render(width)[0]!;
				const plain = baseline.getFooter()!.render(width)[0]!;
				const hasHerder = line.includes("herder: T2 integrate");
				const hasProcess = line.includes("bg 1");
				if (line.includes("English") && hasHerder && hasProcess) seen.languageWithBoth = true;
				if (!line.includes("English") && hasHerder && hasProcess) seen.bothWithoutLanguage = true;
				if (hasHerder && !hasProcess) seen.herderWithoutProcess = true;
				if (!line.includes("English")) expect(line, `${width}`).toBe(plain);
				for (const status of ["herder: T2 integrate", "bg 1"]) {
					if (plain.includes(status)) expect(line, `${width}`).toContain(status);
				}
			}
			expect(seen).toEqual({ languageWithBoth: true, bothWithoutLanguage: true, herderWithoutProcess: true });
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

	it.each(["full", "compact"])("keeps spokesman on the left and language beside context on the right of the %s bar", async (mode) => {
		const harness = createHarness(`spokesman-bar-${mode}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: { language: "English", spokesman: "gpt-4o-mini" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		const rows = mode === "full" ? 2 : 1;
		try {
			const lines = harness.getFooter()!.render(160);
			expect(lines).toHaveLength(rows);
			expect(lines[0]).toContain("\u{F05CA} English");
			expect(lines[0]).toContain("\u{F05CB} gpt-4o-mini");
			expect(lines[0].replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/gpt-4o-mini {3,}◦ ready {3,}\u{F05CA} English  ━/u);
			expect(lines[0]).not.toContain("0×");
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

	it.each(["full", "compact"])("keeps modes in the %s bar and representative in the optional collaboration summary", async (mode) => {
		const harness = createHarness(`modes-bar-${mode}`, "tui", {
			extensionStatuses: [],
			keyedExtensionStatuses: { representative: "📣 rep #auth", selfdrive: "🚗 selfdrive 2h13m", swarm: "🐝 swarm", language: "English" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			const lines = harness.getFooter()!.render(240);
			const bar = lines[0]!;
			// Routine representative folds into the desk workspace row (3 rows total).
			expect(lines).toHaveLength(mode === "full" ? 3 : 1);
			const order = ["English", "\u{F024B} swarm", "\u{F046E} selfdrive 2h13m", "42.5%"].map(text => bar.indexOf(text));
			expect(order.every(index => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(bar).not.toMatch(/[🐝🚗📣]/u);
			const collabRow = mode === "full" ? lines.at(-1)! : lines[0]!;
			expect(collabRow).toContain("\u{F01A1} rep #auth");
			expect(collabRow).not.toContain("📣");
			if (mode === "full") expect(bar).not.toContain("rep #auth");
			for (const line of lines.slice(1)) expect(line).not.toMatch(/swarm|selfdrive/);
			for (const key of ["swarm", "selfdrive", "representative"]) {
				harness.setStatus(key);
				expect(harness.getFooter()!.render(240).join("\n")).not.toContain(key === "representative" ? "rep #auth" : key);
			}
			expect(harness.getFooter()!.render(240)).toHaveLength(mode === "full" ? 3 : 1);
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps the other statuses on their row beside the modes in full mode", async () => {
		const harness = createHarness("modes-beside-row", "tui", { keyedExtensionStatuses: { swarm: "🐝 swarm", other: "SYNC" } });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const lines = harness.getFooter()!.render(160);
			expect(lines).toHaveLength(3);
			expect(lines[0]).toContain("\u{F024B} swarm");
			expect(lines[0]).not.toContain("🐝");
			expect(lines[1]).toContain("SYNC");
			expect(lines[1]).not.toContain("swarm");
		} finally {
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("keeps the modes in the %s bar longer than the provider and the language, and drops them whole", async (mode) => {
		// Full mode draws the bar only above the phone tier, so a longer model name crowds it there.
		const model = mode === "full" ? { id: "k3-preview-with-a-much-longer-model-name-2026", provider: "moonshot", reasoning: true } : undefined;
		const narrowest = mode === "full" ? FOOTER_TIERS.phoneMax + 1 : 24;
		const start = async (id: string, keyedExtensionStatuses: Record<string, string>) => {
			const harness = createHarness(id, "tui", { model, extensionStatuses: [], keyedExtensionStatuses });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			return harness;
		};
		const harness = await start(`modes-order-${mode}`, { swarm: "🐝 swarm", selfdrive: "🚗 selfdrive", language: "English" });
		const baseline = await start(`modes-order-baseline-${mode}`, { language: "English" });
		try {
			const seen = { modesWithoutLanguage: false, dropped: false };
			for (let width = 160; width >= narrowest; width--) {
				const line = harness.getFooter()!.render(width)[0]!;
				const swarm = line.includes("\u{F024B} swarm");
				expect(line.includes("\u{F046E} selfdrive"), `${width}`).toBe(swarm);
				if (!swarm) {
					seen.dropped = true;
					expect(line, `${width}`).toBe(baseline.getFooter()!.render(width)[0]);
					continue;
				}
				if (!line.includes("English")) seen.modesWithoutLanguage = true;
				// Whatever gave way already, the model and the context percentage stay.
				expect(line, `${width}`).toMatch(/\d+\.\d%/);
				if (line.includes("(moonshot)")) expect(line, `${width}`).toContain("English");
			}
			expect(seen).toEqual({ modesWithoutLanguage: true, dropped: true });
		} finally {
			harness.disposeFooter();
			baseline.disposeFooter();
		}
	});

	it("sheds spokesman whole before language as width narrows, and both outlast the provider in full mode", async () => {
		// Full mode draws the bar only above the phone tier, so a longer model name crowds it there.
		const longer = { id: "k3-preview-with-a-much-longer-model-name-2026", provider: "moonshot", reasoning: true };
		const start = async (id: string, mode: "full" | "compact", keyedExtensionStatuses: Record<string, string>) => {
			const harness = createHarness(id, "tui", { model: mode === "full" ? longer : undefined, extensionStatuses: [], keyedExtensionStatuses });
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
			for (let width = 160; width > FOOTER_TIERS.phoneMax; width--) {
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

			const seenCompact = { all: false, languageAndHerder: false, herderOnly: false };
			for (let width = 160; width >= 24; width--) {
				const line = compactHarness.getFooter()!.render(width)[0]!;
				const spokesman = line.includes("gpt-4o-mini");
				const language = line.includes("English");
				const herder = line.includes("herder: T2");
				if (spokesman) expect(language, `${width}`).toBe(true);
				if (spokesman && language && herder) seenCompact.all = true;
				if (!spokesman && language && herder) seenCompact.languageAndHerder = true;
				if (!spokesman && !language && herder) seenCompact.herderOnly = true;
			}
			expect(seenCompact).toEqual({ all: true, languageAndHerder: true, herderOnly: true });
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
			const row2 = lines.at(-2)!;
			expect(row2).toContain("# 1");

			expect(row2).toContain("~$0.150");
			expect(row2).not.toContain("/turn");
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
			keyedExtensionStatuses: { herder: "herder: T2 integrate", goal: "↻ build", other: "SYNC" },
			theme: { fg: (token, text) => `<${token}>${text}`, bold: (text) => text },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			// Set after startup: the footer's process watcher publishes its own key then.
			harness.setStatus(PROCESS_STATUS_KEY, "bg 1 failed");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			let full = harness.getFooter()!.render(200)[1]!;
			expect(full).toMatch(/^ <borderMuted>├ <\w+>herder: T2 integrate/);
			expect(full).toContain("<warning>bg 1 failed");
			expect(full).not.toContain("<error>");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			full = harness.getFooter()!.render(200)[1]!;
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
		expect(lines).toHaveLength(1);
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
		const theme = rgbTheme();
		const harness = createHarness(`fast-chip-${mode}`, "tui", {
			model, theme, thinkingLevel: "xhigh", extensionStatuses: [], hasPendingMessages: true,
			branch: [{ id: "fast-on", type: "custom", customType: "magpie-fast", data: { enabled: true } }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", mode);
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			const bar = harness.getFooter()!.render(160)[0]!;
			expect(bar).toContain(theme.fg("text", "XHIGH"));
			const plainBar = bar.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plainBar).toMatch(/gpt-6\.1-terra +\uE0B0  \u{F0241} ON  \u{F09D1} XHIGH/u);
			expect(plainBar).toContain("◔ queued");
			if (mode === "full") {
				const phone = harness.getFooter()!.render(50)[0]!;
				expect(phone).toContain(theme.fg("text", "XHIGH"));
				expect(phone.replace(/\x1b\[[0-9;]*m/g, "")).toContain("queued · gpt-6.1-terra · XHIGH · 42.5%");
			}
			for (let width = 1; width <= 120; width++) {
				const row = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(row), `${width}`).toBeLessThanOrEqual(width);
				if (row.includes("\u{F0241}")) expect(row, `${width}`).toContain("\u{F0241} ON");
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("fits numeric context beside the long preview identity (Nerd Fonts %s)", async (nerdFonts) => {
		const harness = createHarness(`context-preview-${nerdFonts}`, "tui", {
			model: {
				id: "gpt-6.1-terra", provider: "magpie", api: "openai-responses", reasoning: true,
				magpieServiceTiers: ["priority"], magpiePricing: "estimate",
			},
			theme: rgbTheme(), extensionStatuses: [], isIdle: false, hasPendingMessages: true,
			thinkingLevel: "xhigh",
			contextUsage: { percent: 42.5, tokens: 425_000, contextWindow: 1_000_000 },
			branch: [
				{ id: "compact-1", type: "compaction", summary: "earlier work", firstKeptEntryId: "compact-1", tokensBefore: 90_000 },
				{ id: "compact-2", type: "compaction", summary: "earlier work", firstKeptEntryId: "compact-2", tokensBefore: 90_000 },
				{ id: "fast-on", type: "custom", customType: "magpie-fast", data: { enabled: true } },
			],
			keyedExtensionStatuses: {
				language: "English", spokesman: "auto · Kimi", swarm: "🐝 swarm",
				selfdrive: "🚗 selfdrive 2h13m",
			},
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			for (const width of [121, 122, 123, 124, 125, 180, 240]) {
				const lines = harness.getFooter()!.render(width);
				for (const line of lines) expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				const identity = lines[0]!.replace(/\x1b\[[0-9;]*m/g, "");
				const swarmLabel = nerdFonts === "1" ? "\u{F024B} swarm" : "swarm";
				const selfdriveLabel = nerdFonts === "1" ? "\u{F046E} selfdrive 2h13m" : "selfdrive 2h13m";
				for (const value of ["gpt-6.1-terra", " ON  ", "XHIGH", "English", "auto · Kimi", swarmLabel, selfdriveLabel, "2×", "42.5%"]) {
					expect(identity, `${width}`).toContain(value);
				}
				if (width <= 125) expect(identity, `${width}`).toContain("queued");
				else expect(identity, `${width}`).toContain("working");
				if (nerdFonts === "1" && width < 123) expect(identity).not.toMatch(/425k|1\.0M/);
				else expect(identity).toContain("425k/1.0M");
				if (width === 123 && nerdFonts === "1") {
					expect(identity).toContain("2×  42.5% 425k/1.0M");
					expect(identity).not.toContain("━");
				}
			}
		} finally {
			vi.unstubAllEnvs();
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
			// The bar, the READY status, and a laptop's essentials row.
			expect(lines).toHaveLength(3);
			const bar = lines[0]!;
			const chip = `${bgCode(hex("#D97757"))}${fgCode(hex("#1b1b1f"))}\x1b[1m \u{EC82} claude-opus-5-5 \x1b[22m`;
			expect(bar.startsWith(chip)).toBe(true);
			expect(bar).toContain("working");
			// When too narrow for the centered pill, the chip carries the live ● indicator instead.
			const narrowBar = harness.getFooter()!.render(74)[0]!;
			const liveChip = `${bgCode(hex("#D97757"))}${fgCode(hex("#1b1b1f"))}\x1b[1m ● \u{EC82} claude-opus-5-5 \x1b[22m`;
			expect(narrowBar.startsWith(liveChip)).toBe(true);
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
			expect(lines[1]).toContain("READY");
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
				keyedExtensionStatuses: { goal: status },
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
						if (nerdFonts === "0" || (mode === "full" && width <= FOOTER_TIERS.phoneMax)) expect(bar).not.toMatch(/[\u{E0B0}\u{E0B2}]/u);
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

	it.each(["0", "1"])("fits concurrent compact workflows on a powerline band without leaking ANSI backgrounds (Nerd Fonts %s)", async (nerdFonts) => {
		const harness = createHarness(`powerline-herder-${nerdFonts}`, "tui", {
			model: claude, theme: rgbTheme(), extensionStatuses: [],
			keyedExtensionStatuses: {
				"magpie-quota": "quota paused · resume manually", autoresearch: "research · run 3/20 · measured · Compile 182 ms",
				herder: "\x1b[36mherder: T2 integrate · 3/5 tasks\x1b[0m",
			},
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.runCommand("footer", "compact");
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			for (let width = 1; width <= 200; width++) {
				const line = harness.getFooter()!.render(width)[0]!;
				expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				expect(backgroundAt(line), `${width}`).toBeUndefined();
				for (const marker of ["quota paused", "research", "herder: T2 integrate"]) {
					if (line.includes(marker)) expect(backgroundAt(line, line.indexOf(marker)), `${marker} at ${width}`).toBe(SURFACE_SGR);
				}
			}
			const wide = harness.getFooter()!.render(160)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
			for (const marker of ["quota paused", "research · run 3/20", "herder: T2 integrate · 3/5 tasks"]) expect(wide).toContain(marker);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
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
				const wide = harness.getFooter()!.render(240)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
				const field = `\u{F05CA} ${language}`;
				expect(wide.split(language)).toHaveLength(2);
				expect(wide).toContain(`${skin === "powerline" ? "─ \uE0B2 " : "   "}${field}  ━`);
				expect(wide).not.toContain("0×");
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
		// Long enough to be cut even at the narrowest bar full mode draws.
		const model = { ...longClaude, id: `${longClaude.id}-and-a-suffix` };
		const harness = createHarness("powerline-cut-chip", "tui", { model, theme: rgbTheme() });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			// The narrowest bars full mode draws, above the phone tier.
			for (const width of [FOOTER_TIERS.phoneMax + 1, 76]) {
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
			expect(lines).toHaveLength(3);
			expect(lines[0]).not.toContain("\x1b[48;");
			current = rgbTheme();
			lines = harness.getFooter()!.render(100);
			expect(lines).toHaveLength(3);
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
		const harness = createHarness("powerline-256", "tui", { model: claude, theme, thinkingLevel: "max" });
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
			// MAX rainbow is drawn in truecolor; on the light band (xterm 254) it is lifted to 3:1.
			const maxCell = /\x1b\[38;2;(\d+);(\d+);(\d+)mM/.exec(bar);
			expect(maxCell).not.toBeNull();
			const [r, g, b] = maxCell!.slice(1).map(Number) as [number, number, number];
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
					content: [
						{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", name: "write", arguments: { path: "src/b.ts" } },
					],
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
				keyedExtensionStatuses: { herder: "herder: T2 verify blocked · 3/5 tasks", goal: "↻ build · next 4m" },
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				// A desk with a problem status opens the 4th activity row above telemetry and workspace.
				let lines = harness.getFooter()!.render(200);
				expect(lines).toHaveLength(4);
				expect(lines.slice(1).map(line => strip(line).slice(0, 3))).toEqual([" ├ ", " ├ ", " ╰ "]);
				const [, statuses, telemetry, git] = lines as [string, string, string, string];
				// Clean vertical hairlines separate groups on both sides (no noisy thin chevrons).
				expect(telemetry).toContain(`${tone("borderMuted")}│`);
				expect(telemetry).not.toMatch(/[\u{E0B1}\u{E0B3}]/u);
				expect(strip(telemetry).indexOf(nerd.tools)).toBeLessThan(strip(telemetry).indexOf(nerd.cost));
				expect(statuses).toContain(`${tone("borderMuted")}│`);
				expect(statuses).not.toMatch(/[\u{E0B1}\u{E0B3}]/u);
				// Icons carry the hue, values stay quiet, and the cost leads.
				const item = (hue: string, icon: string, value: string, valueTone = "muted") =>
					`${tone(hue)}\x1b[1m${icon}\x1b[22m\x1b[39m ${tone(valueTone)}${value}`;
				expect(telemetry).toContain(item("warning", nerd.cost, "$0.750", "text"));
				expect(telemetry).toContain(`${tone("dim")}\x1b[2m  $0.375/turn`);
				expect(telemetry).toContain(`${tone("dim")}\x1b[2m\x1b[1m${nerd.tokens}\x1b[22m\x1b[22;39m ${tone("muted")}65k`);
				expect(telemetry).not.toContain(tone("toolDiffAdded"));
				expect(telemetry).not.toContain(tone("toolDiffRemoved"));
				expect(telemetry).toContain(item("syntaxFunction", nerd.tools, "2"));
				// 120k of 185k input tokens were cached: 65%, below the 70% that rates success.
				expect(telemetry).toContain(`${tone("warning")}65%`);
				expect(strip(telemetry)).not.toContain("(~");
				expect(strip(git)).toContain("main");
				expect(strip(git)).toContain("2 edited");
				expect(strip(statuses)).toContain("↻ build · next 4m");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(200);

				for (const key of ["herder", "goal"]) harness.setStatus(key);
				lines = harness.getFooter()!.render(200);
				expect(lines).toHaveLength(3);
				expect(strip(lines.at(-1)!).slice(0, 3)).toBe(" ╰ ");

				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				const plainFonts = harness.getFooter()!.render(200)[1]!;
				expect(plainFonts).toContain(`${tone("borderMuted")}│`);
				expect(plainFonts).not.toMatch(/[\u{E0B1}\u{E0B3}]/u);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("bounds detail rows at small widths and shortens long paths from the middle", async () => {
			const harness = createHarness("detail-fit", "tui", {
				model: claude, branch: activeBranch, extensionStatuses: [],
				cwd: `/tmp/${"deep/".repeat(12)}project`, theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				for (const width of [1, 24, 40, 60, 80, 140, 200]) {
					const lines = harness.getFooter()!.render(width).map(strip);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					if (width >= 40) {
						// The phone row drops the vendor prefix.
						expect(lines[0]).toContain(width > FOOTER_TIERS.phoneMax ? "claude-opus-5-5" : "opus-5-5");
						expect(lines[0]).toContain("42.5%");
					}
				}
				const essentials = strip(harness.getFooter()!.render(80).at(-1)!);
				expect(essentials).toContain("/…/");
				expect(essentials).toContain("project");
				expect(essentials).not.toContain("edited");
				const workspace = strip(harness.getFooter()!.render(200).at(-1)!);
				expect(workspace).toContain("project");
				expect(workspace).toContain("2 edited");
			} finally {
				harness.disposeFooter();
			}
		});

		const relay = (id: string, customType: "relay-received" | "relay-sent") =>
			({ id, type: "custom", customType, data: { id: `msg-${id}`, from: "peer", text: "hello", at: "2026-11-09T00:00:00.000Z" } });
		const relayIcon = "\u{F028C}";
		const editIcon = "\u{F03EB}";

		it("counts relay messages on the active branch, folding routine counts into the desk workspace row", async () => {
			const branch = [
				...activeBranch,
				relay("in-1", "relay-received"),
				relay("out-1", "relay-sent"),
				relay("in-2", "relay-received"),
				relay("in-3", "relay-received"),
				relay("out-2", "relay-sent"),
			];
			const harness = createHarness("detail-relay", "tui", {
				model: claude,
				branch,
				// Off the active branch: never counted.
				entries: [relay("off-in", "relay-received"), relay("off-out", "relay-sent")],
				extensionStatuses: [],
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				// A desk folds routine relay counts into the workspace row (3 rows total).
				const deskLines = harness.getFooter()!.render(200);
				expect(deskLines).toHaveLength(3);
				const workspace = deskLines.at(-1)!;
				const plain = strip(workspace);
				expect(plain).toContain(`${relayIcon} 3 in · 2 out`);
				expect(plain).toContain(`${editIcon} 2 edited`);
				// Drawn like the edited-file count: the same dim icon and quiet value.
				const styleBefore = (icon: string, row: string) => /(?:\x1b\[[0-9;]*m)+$/.exec(row.slice(0, row.indexOf(icon)))?.[0];
				expect(styleBefore(relayIcon, workspace)).toBe(styleBefore(editIcon, workspace));
				expect(workspace).toContain(`${tone("muted")}3 in · 2 out`);
				expect(harness.ctx.sessionManager.getEntries).not.toHaveBeenCalled();

				// A new entry moves the leaf, so the cached counts refresh.
				branch.push(relay("in-4", "relay-received"));
				expect(strip(harness.getFooter()!.render(200).at(-1)!)).toContain(`${relayIcon} 4 in · 2 out`);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it.each([
			["only sent", [relay("out-1", "relay-sent"), relay("out-2", "relay-sent")], "⇌ 2 out"],
			["only received", [relay("in-1", "relay-received")], "⇌ 1 in"],
			["none", [{ id: "user", type: "message", message: { role: "user", timestamp: Date.now() } }], undefined],
		])("leaves out a zero side of the relay counts, and the group when both are zero (%s)", async (label, branch, expected) => {
			const harness = createHarness(`detail-relay-${label}`, "tui", {
				model: claude,
				branch,
				entries: [relay("off-in", "relay-received"), relay("off-out", "relay-sent")],
				extensionStatuses: [],
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				const lines = harness.getFooter()!.render(160);
				const git = strip(expected ? lines[1]! : lines.at(-1)!);
				// Counts alone open the activity row; zero counts leave it closed.
				if (expected) expect(git).toContain(expected);
				else expect(git).not.toContain("⇌");
				expect(git).not.toMatch(/\b0 (in|out)\b/);
				expect(git).not.toContain(" · ");
				expect(git).not.toContain(relayIcon);
				// Compact mode has no Git row and shows no counts.
				await harness.runCommand("footer", "compact");
				const compact = harness.getFooter()!.render(160).map(strip);
				expect(compact).toHaveLength(1);
				expect(compact[0]).not.toContain("⇌");
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});


		it.each(["0", "1"])("shows live room membership without traffic and clears it without a branch change (Nerd Fonts %s)", async (nerdFonts) => {
			const harness = createHarness(`detail-relay-rooms-${nerdFonts}`, "tui", {
				extensionStatuses: [],
				keyedExtensionStatuses: { "relay-rooms": "#dev #ops" },
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
				const icon = nerdFonts === "1" ? relayIcon : "⇌";
				let lines = harness.getFooter()!.render(160).map(strip);
				expect(lines).toHaveLength(3);
				expect(lines[1]).toContain(`${icon} #dev #ops`);
				expect(lines.join("\n")).not.toMatch(/\b0 (in|out)\b/);
				expect(lines.filter(line => line.includes("#dev"))).toHaveLength(1);

				harness.setStatus("relay-rooms", "#ops");
				lines = harness.getFooter()!.render(160).map(strip);
				expect(lines[1]).toContain(`${icon} #ops`);
				expect(lines.join("\n")).not.toContain("#dev");
				await harness.runCommand("footer", "compact");
				expect(strip(harness.getFooter()!.render(160)[0]!)).toContain(`${icon} #ops`);
				harness.setStatus("relay-rooms", undefined);
				expect(strip(harness.getFooter()!.render(160)[0]!)).not.toContain(icon);
				await harness.runCommand("footer", "full");
				lines = harness.getFooter()!.render(160).map(strip);
				expect(lines).toHaveLength(2);
				expect(lines.join("\n")).not.toContain("#ops");
				expect(lines[1]).not.toContain(icon);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("keeps collaboration apart from workspace and bounds small widths", async () => {
			const harness = createHarness("detail-relay-rooms-fit", "tui", {
				branch: [...activeBranch, relay("in", "relay-received"), relay("out", "relay-sent")],
				extensionStatuses: [], keyedExtensionStatuses: { "relay-rooms": "#dev #ops" },
				cwd: `/tmp/${"deep/".repeat(12)}project`,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				// On Desk, routine relay folds into the workspace row (3 rows total); on Laptop, it stays on the activity row.
				const lines = harness.getFooter()!.render(200).map(strip);
				expect(lines).toHaveLength(3);
				expect(lines.at(-1)).toContain("⇌ #dev #ops · 1 in · 1 out");
				expect(lines.at(-1)).toContain("2 edited");
				const laptopLines = harness.getFooter()!.render(140).map(strip);
				expect(laptopLines).toHaveLength(3);
				expect(laptopLines[1]).toContain("⇌ #dev #ops · 1 in · 1 out");
				expect(laptopLines.at(-1)).not.toContain("⇌");
				for (const width of [1, 24, 40, 60, 80, 140]) {
					const rows = harness.getFooter()!.render(width).map(strip);
					for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
					if (width >= 40) {
						expect(rows[0]).toContain("k3");
						expect(rows[0]).toContain("42.5%");
					}
				}
				harness.setStatus("relay-rooms");
				const cleared = strip(harness.getFooter()!.render(200).at(-1)!);
				expect(cleared).toContain("⇌ 1 in · 1 out");
				expect(cleared).not.toContain("#dev");
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("fits compact rooms in the optional tail without displacing workflow, processes, model, or percent", async () => {
			const harness = createHarness("compact-relay-rooms-fit", "tui", {
				extensionStatuses: [],
				keyedExtensionStatuses: { herder: "herder: T2", [PROCESS_STATUS_KEY]: "bg 1 running" },
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", "compact");
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				let sawRooms = false;
				let sawWorkflowWithoutRooms = false;
				for (let width = 200; width >= 1; width--) {
					harness.setStatus("relay-rooms", undefined);
					const baseline = strip(harness.getFooter()!.render(width)[0]!);
					harness.setStatus("relay-rooms", "#dev #ops");
					const lines = harness.getFooter()!.render(width).map(strip);
					expect(lines).toHaveLength(1);
					const line = lines[0]!;
					expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
					for (const marker of ["k3", "42.5%", "herder: T2", "bg 1 running"]) {
						if (baseline.includes(marker)) expect(line, `${width}`).toContain(marker);
					}
					if (line.includes("#dev")) {
						expect(line).toContain("⇌ #dev #ops");
						sawRooms = true;
					} else if (line.includes("herder: T2")) sawWorkflowWithoutRooms = true;
				}
				expect(sawRooms).toBe(true);
				expect(sawWorkflowWithoutRooms).toBe(true);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it.each(["full", "compact"])("bounds long room labels in %s mode", async (mode) => {
			const harness = createHarness(`relay-long-rooms-${mode}`, "tui", {
				extensionStatuses: [],
				keyedExtensionStatuses: { "relay-rooms": `#${"room".repeat(100)} #工具` },
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			try {
				for (let width = 200; width >= 1; width--) {
					const lines = harness.getFooter()!.render(width).map(strip);
					for (const line of lines) expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
					if (width >= 40) {
						expect(lines[0]).toContain("k3");
						expect(lines[0]).toContain("42.5%");
					}
				}
			} finally {
				harness.disposeFooter();
			}
		});

		const memoryPin = (id: string, index: string | null) =>
			({ id, type: "custom", customType: "pika-memory", data: { index, fetchedAt: "2026-11-09T00:00:00.000Z" } });
		const toolResult = (id: string, toolName: string, text: string) => ({
			id,
			type: "message",
			message: { role: "toolResult", toolCallId: `call-${id}`, toolName, content: [{ type: "text", text }], isError: false, timestamp: Date.now() },
		});
		const userEntry = (id: string) => ({ id, type: "message", message: { role: "user", content: "next", timestamp: Date.now() } });
		const compaction = (id: string, firstKeptEntryId: string) =>
			({ id, type: "compaction", summary: "earlier work", firstKeptEntryId, tokensBefore: 50_000 });
		const ids = (entries: object[], prefix: string) => entries.map((entry, index) => ({ ...entry, id: `${prefix}-${index}` }));

		it("counts Pika's pinned memory section and memory tool results after the tokens, styled like the reasoning count", async () => {
			const branch: object[] = [
				...ids(activeBranch, "active"),
				// 1,356 index characters and the section's 444 around them.
				memoryPin("pin", "i".repeat(1_356)),
				toolResult("read-1", "memory_read", "r".repeat(2_000)),
				toolResult("bash-1", "bash", "b".repeat(40_000)),
				toolResult("save-1", "memory_save", "s".repeat(600)),
				toolResult("forget-1", "memory_forget", "f".repeat(400)),
			];
			const harness = createHarness("detail-memory", "tui", {
				model: claude,
				branch,
				// Off the active branch: never counted.
				entries: [memoryPin("off-pin", "o".repeat(100_000)), toolResult("off-read", "memory_read", "o".repeat(100_000))],
				extensionStatuses: [],
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				// 1,800 + 2,000 + 600 + 400 characters at four per token; the bash output is not memory.
				const telemetry = harness.getFooter()!.render(200).at(-2)!;
				expect(strip(telemetry)).toContain("65%  │  ~1.2k memory  │  12k think");
				expect(telemetry).toContain(`${tone("dim")}\x1b[2m~1.2k memory`);
				expect(telemetry).toContain(`${tone("dim")}\x1b[2m12k think`);
				expect(harness.ctx.sessionManager.getEntries).not.toHaveBeenCalled();

				// A new result moves the leaf, so the cached count refreshes.
				branch.push(toolResult("read-2", "memory_read", "r".repeat(1_200)));
				expect(strip(harness.getFooter()!.render(200).at(-2)!)).toContain("~1.5k memory");

				// Compact mode has no telemetry row and shows no memory.
				await harness.runCommand("footer", "compact");
				const compact = harness.getFooter()!.render(200).map(strip);
				expect(compact).toHaveLength(1);
				expect(compact[0]).not.toContain("memory");
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it.each([
			// 3 + 444 characters round up to 112 tokens.
			["an index", [memoryPin("pin", "abc")], "~112 memory"],
			["a null index", [memoryPin("pin", null)], undefined],
			["no pin", [], undefined],
			["only other tools' results", [memoryPin("pin", null), toolResult("bash-1", "bash", "b".repeat(4_000))], undefined],
		])("shows Pika memory only when it has a size (%s)", async (label, memory, expected) => {
			const harness = createHarness(`detail-memory-${label}`, "tui", {
				model: claude,
				branch: [...ids(activeBranch, "active"), ...memory],
				entries: [memoryPin("off-pin", "o".repeat(4_000)), toolResult("off-read", "memory_read", "o".repeat(4_000))],
				extensionStatuses: [],
				theme: tagged,
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				const telemetry = strip(harness.getFooter()!.render(200).at(-2)!);
				if (expected) expect(telemetry).toContain(`│  ${expected}  │  12k think`);
				else expect(telemetry).not.toContain("memory");
				expect(telemetry).not.toContain("~0");
				expect(telemetry).toContain("12k think");
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("stops counting memory tool results that the latest compaction leaves out of context", async () => {
			const branch: object[] = [
				userEntry("user-1"),
				// 356 index characters and 444 around them: the section stays in the prompt through compactions.
				memoryPin("pin", "p".repeat(356)),
				toolResult("read-old", "memory_read", "a".repeat(4_000)),
				userEntry("kept"),
				toolResult("read-kept", "memory_read", "k".repeat(800)),
				compaction("compaction-1", "kept"),
				toolResult("read-new", "memory_save", "n".repeat(400)),
			];
			const harness = createHarness("detail-memory-compaction", "tui", { model: claude, branch, extensionStatuses: [] });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				const telemetry = () => harness.getFooter()!.render(200).at(-2)!;
				// 800 + 800 + 400 characters; the 4,000 before the first kept entry are summarized away.
				expect(telemetry()).toContain("~500 memory");

				// A compaction that keeps nothing before it leaves only the section.
				branch.push(compaction("compaction-2", "compaction-2"));
				expect(telemetry()).toContain("~200 memory");

				// Results after the latest compaction count again.
				branch.push(toolResult("read-after", "memory_read", "z".repeat(400)));
				expect(telemetry()).toContain("~300 memory");
				expect(harness.ctx.sessionManager.getEntries).not.toHaveBeenCalled();
			} finally {
				harness.disposeFooter();
			}
		});

		it.each(["0", "1"])("keeps every metric visible at a desk and the essentials on a laptop with concurrent features (Nerd Fonts %s)", async (nerdFonts) => {
			let now = Date.now();
			const started = now;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
				const output = args?.[1] === "status" ? " M src/a.ts\n"
					: args?.[0] === "diff" ? "2 files changed, 42 insertions(+), 17 deletions(-)"
					: "1\t2";
				(callback as (error: null, stdout: string) => void)(null, output);
				return {} as ReturnType<typeof execFile>;
			});
			const branch = [
				...ids(activeBranch, "active"),
				memoryPin("pin", "abc"),
				toolResult("read", "memory_read", "r".repeat(2_000)),
				{ ...toolResult("failed", "bash", "failed"), message: { role: "toolResult", isError: true } },
				relay("in1", "relay-received"), relay("in2", "relay-received"), relay("out", "relay-sent"),
				compaction("compaction", "active-0"),
			];
			const harness = createHarness(`all-features-${nerdFonts}`, "tui", {
				model: claude, branch, extensionStatuses: [], theme: tagged,
				keyedExtensionStatuses: {
					autoresearch: "research 2/5", herder: "herder: T2 integrate · 3/5 tasks", goal: "↻ build · next 4m",
					subagents: "subagents: on", other: "SYNC",
					language: "English", spokesman: "gpt-4o-mini", swarm: "🐝 swarm",
					selfdrive: "🚗 selfdrive", representative: "📣 rep #dev", "relay-rooms": "#dev #dev-old #ops",
				},
			});
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
				harness.setStatus(PROCESS_STATUS_KEY, "bg 2 running · 1 failed");
				for (const sample of [
					{ start: 1_000, response: 1_100, first: 1_200, end: 3_000, output: 200 },
					{ start: 4_000, response: 4_150, first: 4_400, end: 8_000, output: 600 },
				]) {
					now = started + sample.start;
					await harness.emit("before_provider_headers", { headers: {} });
					now = started + sample.response;
					await harness.emit("after_provider_response", {});
					now = started + sample.first;
					await harness.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "sample" } });
					now = started + sample.end;
					await harness.emit("message_end", assistantEnd(sample.output));
				}
				// A laptop keeps what to act on in one row.
				const laptop = harness.getFooter()!.render(140).map(strip);
				expect(laptop).toHaveLength(3);
				for (const line of laptop) expect(visibleWidth(line)).toBeLessThanOrEqual(140);
				expect(laptop[1]).toContain("bg 2 running · 1 failed");
				const essentials = laptop[2]!;
				expect(essentials.startsWith(" ╰ ")).toBe(true);
				for (const fact of ["main", "+42", "−17", "↑ 2  ↓ 1", "$0.750", "1h 00m", "1 (50.0%)", "300ms", "133 tok/s", "65%", "/tmp/project"]) {
					expect(essentials).toContain(fact);
				}
				for (const diagnostic of ["150ms", "400ms", "150 tok/s", "/turn", "65k", "31k", "120k", "memory", "think", "edited"]) {
					expect(essentials).not.toContain(diagnostic);
				}
				for (const width of [175, 193, 240, 400]) {
					const lines = harness.getFooter()!.render(width).map(strip);
					expect(lines).toHaveLength(4);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					const [identity, activity, telemetry, workspace] = lines as [string, string, string, string];
					expect(identity).toContain("claude-opus-5-5");
					expect(identity).toContain("42.5%");
					expect(identity).toContain("1×");
					expect(identity).toContain("43k/100k");
					expect(identity).not.toContain("rep #dev");
					expect(activity).toContain("bg 2 running · 1 failed");
					const repLabel = nerdFonts === "1" ? "\u{F01A1} rep #dev" : "rep #dev";
					expect(activity).toContain(repLabel);
					expect(activity).not.toContain("📣");
					expect(activity).toContain("#dev-old #ops · 2 in · 1 out");
					expect(telemetry).toContain(nerdFonts === "1" ? "\u{F05B7} 2" : "⚙ 2");
					expect(telemetry).toContain(nerdFonts === "1" ? "\u{F0368} 2" : "# 2");
					for (const metric of ["1h 00m", "1 (50.0%)", "300ms (400ms)", "133 tok/s (150)"]) expect(telemetry).toContain(metric);
					expect(telemetry).not.toContain("ttfb");
					for (const metric of ["$0.750", "$0.375/turn", "65k", "31k", "120k", "65%", "~612 memory", "12k think"]) expect(telemetry).toContain(metric);
					for (const fact of ["main", "+42", "−17", "↑ 2  ↓ 1", "2 edited", "/tmp/project"]) expect(workspace).toContain(fact);
					expect(workspace).not.toContain("rep");
					expect(workspace).not.toContain("#ops");
					expect(workspace.startsWith(" ╰ ")).toBe(true);
					if (width === 400) {
						for (const status of ["research 2/5", "herder: T2 integrate", "↻ build", "subagents: on", "SYNC", repLabel, "#dev-old #ops · 2 in · 1 out"]) expect(activity).toContain(status);
						expect(activity.split(/(?<=\s)#dev(?=\s|$)/)).toHaveLength(2);
					}
				}
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it.each([
			["role only", { representative: "📣 rep #dev" }, [], "rep #dev"],
			["rooms only", { "relay-rooms": "#dev #ops" }, [], "⇌ #dev #ops"],
			["counts only", {}, [relay("in", "relay-received"), relay("out", "relay-sent")], "⇌ 1 in · 1 out"],
		] as const)("opens an activity row for %s without a workflow", async (label, statuses, branch, expected) => {
			const harness = createHarness(`activity-${label}`, "tui", { extensionStatuses: [], keyedExtensionStatuses: statuses, branch: [...branch] });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				const lines = harness.getFooter()!.render(140).map(strip);
				expect(lines).toHaveLength(3);
				expect(lines[1]).toContain(expected);
				expect(lines[1]!.startsWith(" ├ ")).toBe(true);
				expect(lines.at(-1)!.startsWith(" ╰ ")).toBe(true);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it.each(["full", "compact"])("deduplicates exact plain role room tokens in %s mode", async (mode) => {
			const harness = createHarness(`dedup-${mode}`, "tui", { extensionStatuses: [], keyedExtensionStatuses: {
				representative: "📣 rep #dev #ops", "relay-rooms": "#dev #dev-old #ops #qa",
			} });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			await harness.runCommand("footer", mode);
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				const summary = () => harness.getFooter()!.render(240)[mode === "full" ? 2 : 0]!;
				expect(summary()).toContain("rep #dev #ops");
				expect(summary()).not.toContain("📣");
				expect(summary()).toContain("⇌ #dev-old #qa");
				expect(summary().match(/(?<=\s)#dev(?=\s|$)/g)).toHaveLength(1);
				expect(summary().match(/(?<=\s)#ops(?=\s|$)/g)).toHaveLength(1);
				// Punctuation is not a whitespace boundary; #dev-old is a different room.
				harness.setStatus("representative", "📣 rep #dev-old #ops,");
				expect(summary()).toContain("⇌ #dev #ops #qa");
				harness.setStatus("representative", "📣 rep #dev #dev-old #ops #qa");
				expect(summary()).not.toContain("⇌");
				harness.setStatus("representative");
				expect(summary()).toContain("⇌ #dev #dev-old #ops #qa");
				harness.setStatus("relay-rooms");
				expect(harness.getFooter()!.render(240)).toHaveLength(mode === "full" ? 3 : 1);
				if (mode === "full") expect(harness.getFooter()!.render(240).at(-1)!.startsWith(" ╰ ")).toBe(true);
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		});

		it("keeps unknown status icons and hues, prioritizes severity, and clears statuses live", async () => {
			// Each status alone nearly fills a laptop's narrowest activity row.
			const blocked = "custom blocked · waiting on the release lock";
			const paused = "↻ paused · waiting for the user to approve";
			const running = "research running · iteration 12 of 40";
			const harness = createHarness("activity-severity", "tui", { extensionStatuses: [], theme: tagged, keyedExtensionStatuses: {
				autoresearch: running, goal: paused, custom: blocked,
			} });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
				const wide = harness.getFooter()!.render(240)[1]!;
				expect(wide).toContain(renderStatus(tagged as unknown as Parameters<typeof renderStatus>[0], blocked, "custom", true));
				expect(wide).toContain("\u{F0431}");
				const narrowest = () => strip(harness.getFooter()!.render(FOOTER_TIERS.phoneMax + 1)[1]!);
				expect(narrowest()).toContain(blocked);
				expect(narrowest()).not.toContain("research running");
				expect(narrowest()).not.toContain("paused");
				harness.setStatus("custom");
				expect(narrowest()).toContain(paused);
				expect(narrowest()).not.toContain("research running");
				harness.setStatus("goal");
				expect(narrowest()).toContain(running);
				harness.setStatus("autoresearch");
				expect(harness.getFooter()!.render(140)).toHaveLength(2);
				harness.setStatus("custom", "custom ready");
				expect(harness.getFooter()!.render(240).at(-1)).toContain(renderStatus(tagged as unknown as Parameters<typeof renderStatus>[0], "custom ready", "custom", true));
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
			expect(lines).toHaveLength(3);
			for (const line of lines) expect(line).not.toContain("\x1b[48;");
			expect(lines[0]).toContain("claude-opus-5-5");
			expect(lines[0]).toContain("42.5%");
			expect(lines[0]).not.toMatch(/[\u{E0B0}\u{E0B2}]/u);
			const rails = lines.slice(1).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 3));
			expect(rails).toEqual([" ├ ", " ╰ "]);
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
				expect(harness.notifications.at(-1)).toBe(`Unknown /footer argument '${style}' — usage: /footer [full|compact|off|default [full|compact|off]|debug]`);
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
			expect(harness.getFooter()!.render(240).at(-1)).toContain("bg 1 running");
			core.update([{ status: "exited", success: false }, { status: "running" }]);
			expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(PROCESS_STATUS_KEY, "bg 1 running · 1 failed");
			expect(harness.getFooter()!.render(240)[1]).toContain("bg 1 running · 1 failed");
			core.update([{ status: "exited", success: true }]);
			expect(harness.getFooter()!.render(240).at(-1)).toContain("bg 1 done");
			core.update([]);
			expect(harness.getFooter()!.render(240).join("\n")).not.toContain("bg ");
			core.update({ invalid: true });
			expect(harness.getFooter()!.render(240).join("\n")).not.toContain("bg ");
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
			expect(harness.getFooter()!.render(120)[1]).toContain("bg 1 stopping");
			core.update([{ status: "terminate_timeout" }], false);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(harness.getFooter()!.render(120)[1]).toContain("bg 1 stuck");
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
			const full = harness.getFooter()!.render(72);
			expect(full.at(-1)).toContain("main");
			expect(full[1]).toContain("bg 1 running");
			expect(full[1]!.split("bg 1 running")).toHaveLength(2);
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
			harness.setStatus("subagents", "2 running agents");
			const wide = harness.getFooter()!.render(160)[0]!;
			expect(wide).toContain("research 2/5");
			expect(wide).toContain("bg 1 running");
			expect(wide).not.toContain("2 running agents");
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
			expect(root.getFooter()!.render(120)[1]).toContain("bg 1 done");
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
			expect(root.getFooter()!.render(120)[1]).toContain("bg 1 running");
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
			const priceLine = mode === "full" ? lines.at(-2)! : lines[0]!;
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
		const line = harness.getFooter()!.render(240).at(-2)!;
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
		expect(harness.getFooter()!.render(240).at(-2)).toContain("$0.000");
		expect(harness.getFooter()!.render(240).at(-2)).not.toContain("price unavailable");
		harness.disposeFooter();
	});

	it("counts explicit known zero pricing as free and marks positive untagged Magpie costs estimated", async () => {
		const harness = createHarness("pricing-estimates", "tui", {
			model: freeModel,
			branch: [
				{ type: "message", message: { role: "user" } },
				assistant("magpie", 0, "estimate"),
				{ type: "message", message: { role: "user" } },
				assistant("magpie", 0.75),
				assistant("other", 0),
			],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const full = harness.getFooter()!.render(240).at(-2)!;
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
		expect(harness.getFooter()!.render(240).at(-2)).toContain("price unavailable");
		harness.disposeFooter();
	});

	it.each(["input", "output", "cacheRead", "cacheWrite"] as const)("treats %s tokens with unavailable pricing as unpriced", async (counter) => {
		const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [counter]: 1 };
		const harness = createHarness(`pricing-${counter}-only`, "tui", {
			branch: [{ type: "compaction", usage: usage(0, "unavailable", tokens) }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240).at(-2)).toContain("price unavailable");
		harness.disposeFooter();
	});

	it("keeps zero-token unavailable usage out of the missing-price count", async () => {
		const harness = createHarness("pricing-empty-usage", "tui", {
			branch: [{ type: "compaction", usage: usage(0, "unavailable", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240).at(-2)).toContain("$0.000");
		expect(harness.getFooter()!.render(240).at(-2)).not.toContain("price unavailable");
		harness.disposeFooter();
	});

	it("treats explicitly estimated native compaction usage as priced even at zero cost", async () => {
		const harness = createHarness("pricing-compaction-estimate", "tui", {
			branch: [{ type: "compaction", usage: usage(0, "estimate") }],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240).at(-2)).toContain("~$0.000");
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
		const line = harness.getFooter()!.render(240).at(-2)!;
		expect(line).toContain(pricing === "unavailable" ? "price unavailable" : "~$0.250");
		harness.disposeFooter();
	});

	it("shows selected Magpie model's unavailable price before any usage", async () => {
		const harness = createHarness("pricing-current-empty", "tui", {
			model: { ...freeModel, id: "unpriced", provider: "magpie", magpiePricing: "unavailable" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		expect(harness.getFooter()!.render(240).at(-2)).toContain("price unavailable");
		await harness.runCommand("footer", "compact");
		expect(harness.getFooter()!.render(240)[0]).toContain("price unavailable");
		harness.disposeFooter();
	});

	it("reads the current model on every render, even at the same branch leaf", async () => {
		const harness = createHarness("pricing-model-switch", "tui", { model: freeModel, branch: [assistant("other", 1)] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const full = () => harness.getFooter()!.render(240).at(-2)!;
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
				const priceLine = harness.getFooter()!.render(240).at(mode === "full" ? -2 : 0)!;
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
		// 3 samples × 3 phase transitions (waiting, streaming, idle)
		expect(harness.requestRender).toHaveBeenCalledTimes(9);

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
			keyedExtensionStatuses: { language: "简体中文", swarm: "🐝 swarm", selfdrive: "🚗 selfdrive" },
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.runCommand("footer", mode);
		const line = () => harness.getFooter()!.render(160)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			expect(line()).toContain(`${model.id}  ϟ OFF  ∴ HIGH`);
			expect(line()).toMatch(/ {3,}简体中文  swarm  selfdrive  ━/);
			expect(line()).not.toContain("0×");
			branch.push({ id: "on", type: "custom", customType: "magpie-fast", data: { enabled: true } });
			expect(line()).toContain(`${model.id}  ϟ ON  ∴ HIGH`);
			await harness.emit("before_provider_request", { payload: { service_tier: "priority" } });
			expect(line()).toContain(`${model.id}  ϟ ON  ∴ HIGH`);
			branch.push({ id: "off", type: "custom", customType: "magpie-fast", data: { enabled: false } });
			expect(line()).toContain(`${model.id}  ϟ OFF  ∴ HIGH`);
			await harness.emit("before_provider_request", { payload: { service_tier: "flex" } });
			expect(line()).toContain(`${model.id}  ϟ OFF  last FLEX  ∴ HIGH`);
			await harness.emit("before_provider_request", { payload: { service_tier: "priority" } });

			// Navigating back restores the branch's state without a provider request.
			branch.pop();
			expect(line()).toContain(`${model.id}  ϟ ON  ∴ HIGH`);
			catalog.splice(0);
			expect(line()).not.toContain("ϟ");
			catalog.push(model);
			harness.ctx.model = { ...model, provider: "other" } as typeof harness.ctx.model;
			await harness.emit("model_select", { type: "model_select" });
			expect(line()).not.toContain("ϟ");
			for (const tier of ["priority", "fast", "flex"]) {
				await harness.emit("before_provider_request", { payload: { service_tier: tier } });
				expect(line()).toContain(`${model.id}  ϟ ${tier.toUpperCase()}  ∴ HIGH`);
			}
			harness.ctx.model = model as typeof harness.ctx.model;
			await harness.emit("model_select", { type: "model_select" });
			expect(line()).toContain(`${model.id}  ϟ ON  ∴ HIGH`);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("fits effort, Fast, and the last request whole in the %s bar", async (mode) => {
		const model: HarnessModel = {
			id: "gpt-6.1-terra-with-a-long-model-identifier-for-narrow-laptops", provider: "magpie",
			api: "openai-responses", reasoning: true, magpieServiceTiers: ["priority"], magpiePricing: "estimate",
		};
		const harness = createHarness(`magpie-fast-width-${mode}`, "tui", { model, thinkingLevel: "xhigh", extensionStatuses: [] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("before_provider_request", { payload: { service_tier: "flex" } });
		await harness.runCommand("footer", mode);
		try {
			for (const [fonts, brain, bolt] of [["0", "∴", "ϟ"], ["1", "\u{F09D1}", "\u{F0241}"]] as const) {
				vi.stubEnv("STATUSLINE_NERD_FONTS", fonts);
				const stages = new Set<number>();
				for (let width = 1; width <= 130; width++) {
					const row = harness.getFooter()!.render(width)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
					expect(visibleWidth(row), `${width}`).toBeLessThanOrEqual(width);
					if (mode === "full" && width <= FOOTER_TIERS.phoneMax) {
						expect(row).not.toMatch(/[∴ϟ\u{F09D1}\u{F0241}]|OFF|FLEX/u);
						continue;
					}
					const effort = `${brain} XHIGH`;
					const fast = `${bolt} OFF`;
					const last = "last FLEX";
					if (row.includes(brain) || row.includes("HIGH")) expect(row).toContain(effort);
					if (row.includes(bolt) || row.includes("OF")) expect(row).toContain(fast);
					if (row.includes("last") || row.includes("FLEX")) expect(row).toContain(`${fast}  ${last}`);
					if (width >= visibleWidth(` ⊛ ${model.id} 42.5% `)) {
						expect(row).toContain(model.id);
						expect(row).toContain("42.5%");
					}
					stages.add([effort, fast, last].filter(field => row.includes(field)).length);
				}
				expect(stages).toEqual(new Set([0, 1, 2, 3]));
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["anthropic", "magpie"])("reads speed and capacity separately on %s Messages requests", async (provider) => {
		const model = {
			id: "claude-opus", provider, api: "anthropic-messages", reasoning: true,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		};
		const harness = createHarness(`messages-settings-${provider}`, "tui", { model });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const identity = () => harness.getFooter()!.render(160)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
		const request = (payload: Record<string, string>) => harness.emit("before_provider_request", { payload });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			for (const [payload, label] of [
				[{ speed: "fast" }, "FAST"],
				[{ speed: "standard" }, undefined],
				[{ service_tier: "standard_only" }, "STANDARD_ONLY"],
				[{ service_tier: "auto" }, undefined],
				[{ speed: "fast", service_tier: "standard_only" }, "FAST · STANDARD_ONLY"],
				[{ speed: "standard", service_tier: "standard_only" }, "STANDARD_ONLY"],
				[{ speed: "fast", service_tier: "auto" }, "FAST"],
				[{}, undefined],
			] as const) {
				await request(payload);
				expect(identity()).toContain(`${model.id}  ${label ? `ϟ ${label}  ` : ""}∴ HIGH`);
			}
			await request({ speed: "fast", service_tier: "standard_only" });
			harness.ctx.model = { ...harness.ctx.model!, api: "openai-completions" };
			await harness.emit("model_select", { type: "model_select" });
			expect(identity()).not.toContain("ϟ");
			await request({ speed: "fast", service_tier: "standard_only" });
			expect(identity()).not.toContain("ϟ");
			await request({ speed: "fast", service_tier: "priority" });
			expect(identity()).toContain(`${model.id}  ϟ PRIORITY  ∴ HIGH`);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["full", "compact"])("restores the combined Messages badge and fits it whole in %s mode", async (mode) => {
		const model = { id: "claude-opus-with-a-long-model-identifier", provider: "anthropic", api: "anthropic-messages" };
		const harness = createHarness(`messages-reload-${mode}`, "tui", { model });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("before_provider_request", { payload: { speed: "fast", service_tier: "standard_only" } });
		harness.disposeFooter();
		await harness.emit("session_shutdown", { reason: "reload" });
		await harness.emit("session_start", { reason: "reload" });
		await harness.runCommand("footer", mode);
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const badge = "ϟ FAST · STANDARD_ONLY";
			const bar = (width: number) => harness.getFooter()!.render(width)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
			expect(bar(160)).toContain(`${model.id}  ${badge}`);
			expect(bar(60)).not.toContain("ϟ");
			for (let width = 40; width <= 100; width++) {
				const line = bar(width);
				expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				expect(line).toContain("42.5%");
				if (/ϟ|FAST|STANDARD/.test(line)) expect(line).toContain(badge);
			}
		} finally {
			vi.unstubAllEnvs();
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
		expect(root.getFooter()!.render(240)[0]).toContain("PRIORITY");
		await root.emit("before_provider_request", { payload });
		expect(root.getFooter()!.render(240)[0]).not.toContain("PRIORITY");
		expect(other.getFooter()!.render(240)[0]).toContain("PRIORITY");

		await root.emit("before_provider_request", { payload: { service_tier: "priority" } });
		root.requestRender.mockClear();
		await print.emit("before_provider_request", { payload: {} });
		await print.emit("model_select", { type: "model_select" });
		expect(root.getFooter()!.render(240)[0]).toContain("PRIORITY");
		expect(root.requestRender).not.toHaveBeenCalled();
		await root.emit("model_select", { type: "model_select" });
		expect(root.getFooter()!.render(240)[0]).not.toContain("PRIORITY");
		expect(root.requestRender).toHaveBeenCalledOnce();
		expect(other.getFooter()!.render(240)[0]).toContain("PRIORITY");
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
		// Root's 3 phase transitions (waiting, streaming, idle); child's events never touched root.
		expect(root.requestRender).toHaveBeenCalledTimes(3);

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
		expect(harness.getFooter()!.render(240)[0]).not.toContain("PRIORITY");
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
		expect(harness.getFooter()!.render(240)[0]).toContain("PRIORITY");

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
		expect(harness.getFooter()!.render(240)[0]).not.toContain("PRIORITY");
		expect(harness.ctx.sessionManager.getEntries).not.toHaveBeenCalled();
		harness.disposeFooter();
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: reason === "startup" ? "quit" : reason });
		expect(persistedEntries(harness.pi)).toEqual([]);
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
		expect(persistedEntries(root.pi)).toEqual([]);
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
		expect(afterReload.getFooter()!.render(240)[0]).toContain("PRIORITY");
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
		expect(persistedEntries(afterReload.pi)).toEqual([]);
	});
});

describe("statusline footer width tiers", () => {
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const claude = { id: "claude-opus-5-5", provider: "anthropic", reasoning: true };
	// Nerd Font glyphs live in the private-use planes; the phone row never draws one.
	const PRIVATE_USE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/u;
	const toolResult = (id: string, isError: boolean) =>
		({ id, type: "message", message: { role: "toolResult", toolCallId: `call-${id}`, toolName: "bash", content: [], isError, timestamp: Date.now() } });

	/** A working session an hour in, with every metric the desk shows. */
	function session(options: { errors?: number; calls?: number; turns?: number; scale?: number; startedMs?: number; cacheWrite?: number } = {}) {
		const { errors = 1, calls = 2, turns = 2, scale = 1, startedMs = 3_600_000, cacheWrite = 0 } = options;
		return [
			...Array.from({ length: turns }, (_, index) => ({
				id: `user-${index}`, type: "message", message: { role: "user", timestamp: Date.now() - (index ? 0 : startedMs) },
			})),
			{
				id: "assistant", type: "message",
				message: {
					role: "assistant", provider: "anthropic",
					usage: { input: 65_200 * scale, output: 31_400 * scale, cacheRead: 120_000 * scale, cacheWrite: cacheWrite * scale, reasoning: 12_100 * scale, cost: { total: 0.75 * scale } },
					content: Array.from({ length: calls }, (_, index) => ({ type: "toolCall", name: "edit", arguments: { path: `src/${index}.ts` } })),
				},
			},
			{ id: "pin", type: "custom", customType: "pika-memory", data: { index: "i".repeat(1_356 * scale), fetchedAt: "2026-11-09T00:00:00.000Z" } },
			...Array.from({ length: errors }, (_, index) => toolResult(`failed-${index}`, true)),
		];
	}

	/** Git reports a dirty tree with a diff and an upstream; `hold` keeps it pending until `release`. */
	function git(hold = false) {
		const held: Array<() => void> = [];
		vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
			const output = args?.[1] === "status" ? " M src/a.ts\n"
				: args?.[0] === "diff" ? "2 files changed, 42 insertions(+), 17 deletions(-)"
				: "1\t2";
			const complete = () => (callback as (error: null, stdout: string) => void)(null, output);
			if (hold) held.push(complete);
			else complete();
			return {} as ReturnType<typeof execFile>;
		});
		return { release: () => held.splice(0).forEach(complete => complete()) };
	}

	async function start(id: string, options: HarnessOptions = {}) {
		const harness = createHarness(id, "tui", { model: claude, branch: session(), extensionStatuses: [], ...options });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		return harness;
	}

	/** Two measured requests: TTFT 200 and 400ms, TTFB 150ms last, 133 tok/s on average and 150 last. */
	async function stream(harness: ReturnType<typeof createHarness>, scale = 1) {
		let now = Date.now();
		const started = now;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		for (const sample of [
			{ start: 1_000, response: 1_100, first: 1_200, end: 3_000, output: 200 },
			{ start: 4_000, response: 4_150, first: 4_400, end: 8_000, output: 600 },
		]) {
			now = started + sample.start * scale;
			await harness.emit("before_provider_headers", { headers: {} });
			now = started + sample.response * scale;
			await harness.emit("after_provider_response", {});
			now = started + sample.first * scale;
			await harness.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "sample" } });
			now = started + sample.end * scale;
			await harness.emit("message_end", assistantEnd(sample.output));
		}
	}

	it.each(["0", "1"])("spaces numeric icons in full and compact mode (Nerd Fonts %s)", async (nerdFonts) => {
		git();
		const harness = await start(`metric-spaces-${nerdFonts}`, {
			branch: [
				{ id: "c1", type: "compaction", summary: "compact", firstKeptEntryId: "c1", tokensBefore: 50_000 },
				...session(),
			],
		});
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			await stream(harness);
			const nerd = nerdFonts === "1";
			const compactions = nerd ? "\u{F0615} 1×" : "× 1×";
			const activity = nerd ? "\u{F0368} 2  \u{F0954} 1h 00m" : "# 2  ◷ 1h 00m";
			const price = nerd ? "\u{F01C1} $0.750" : "$0.750";
			const [bar, telemetry, workspace] = harness.getFooter()!.render(175).map(strip);
			expect(bar).toContain(compactions);
			expect(telemetry).toContain(activity);
			expect(telemetry).toContain(nerd ? "\u{F051B} 300ms (400ms)" : "⏱ 300ms (400ms)");
			expect(telemetry).toContain(nerd ? "\u{F04C5} 133 tok/s (150)" : "» 133 tok/s (150)");
			expect(telemetry).toContain(nerd ? "\u{F0046} 31k  \u{F140B} 120k 65%" : "↓ 31k  ⚡ 120k 65%");
			expect(workspace).toContain("+42 −17  ↑ 2  ↓ 1");
			await harness.runCommand("footer", "compact");
			const compact = strip(harness.getFooter()!.render(100)[0]!);
			expect(compact).toContain(compactions);
			expect(compact).toContain(`${price}  1h 00m`);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("picks the tier from the width alone, with and without an activity row", async () => {
		git();
		const harness = await start("tier-boundaries");
		try {
			const rows = () => Object.fromEntries([71, 72, 174, 175].map(width => [width, harness.getFooter()!.render(width).length]));
			expect(rows()).toEqual({ 71: 1, 72: 2, 174: 2, 175: 3 });
			harness.setStatus("goal", "goal: ship the tiers");
			// Routine status folds into desk Row 3 (3 rows) while laptop opens an activity row (3 rows).
			expect(rows()).toEqual({ 71: 1, 72: 3, 174: 3, 175: 3 });
			harness.setStatus("goal", "goal: ship the tiers blocked");
			// Problem/attention status promotes to a dedicated 4th activity row on desk.
			expect(rows()).toEqual({ 71: 1, 72: 3, 174: 3, 175: 4 });
			const lines = harness.getFooter()!.render(175).map(strip);
			expect(lines.slice(1).map(line => line.slice(0, 3))).toEqual([" ├ ", " ├ ", " ╰ "]);
			expect(strip(harness.getFooter()!.render(174).at(-1)!).slice(0, 3)).toBe(" ╰ ");
			// Compact mode stays one row at any width; off draws nothing.
			await harness.runCommand("footer", "compact");
			for (const width of [40, 71, 72, 174, 175, 400]) expect(harness.getFooter()!.render(width)).toHaveLength(1);
			await harness.runCommand("footer", "off");
			expect(harness.getFooter()).toBeUndefined();
		} finally {
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("stays within width from 20 to 400 columns in every tier (Nerd Fonts %s)", async (nerdFonts) => {
		git();
		const harness = await start(`tier-widths-${nerdFonts}`, {
			cwd: `/tmp/${"deep/".repeat(12)}project`,
			keyedExtensionStatuses: { herder: "herder: T2 verify blocked · 3/5 tasks", goal: "goal: ship the tiers", representative: "📣 rep #dev" },
		});
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			await stream(harness);
			for (let width = 20; width <= 400; width++) {
				const lines = harness.getFooter()!.render(width);
				expect(lines, `${width}`).toHaveLength(width <= FOOTER_TIERS.phoneMax ? 1 : width >= FOOTER_TIERS.deskMin ? 4 : 3);
				for (const line of lines) expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it.each(["0", "1"])("keeps every metric at a desk on one telemetry row above the workspace (Nerd Fonts %s)", async (nerdFonts) => {
		git();
		const harness = await start(`desk-metrics-${nerdFonts}`, { branch: [...session(), toolResult("ok", false)] });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
			await stream(harness);
			const lines = harness.getFooter()!.render(193).map(strip);
			expect(lines).toHaveLength(3);
			const [, telemetry, workspace] = lines as [string, string, string];
			expect(telemetry.startsWith(" ├ ")).toBe(true);
			expect(workspace.startsWith(" ╰ ")).toBe(true);
			for (const metric of [
				"1h 00m", nerdFonts === "1" ? "\u{F05B7} 2" : "⚙ 2", "1 (50.0%)", "300ms (400ms)", "133 tok/s (150)",
				"$0.750", "$0.375/turn", "65k", "31k", "120k", "65%", "~450 memory", "12k think",
			]) expect(telemetry).toContain(metric);
			expect(telemetry).not.toContain("ttfb");
			// Performance on the left, resources on the right.
			expect(telemetry.indexOf("tok/s")).toBeLessThan(telemetry.indexOf("$0.750"));
			for (const fact of ["main", "+42", "−17", "↑ 2  ↓ 1", "2 edited", "/tmp/project"]) expect(workspace).toContain(fact);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("drops desk diagnostics before actionable facts, and keeps failed tool calls longer", async () => {
		// Lower ranks drop first; failed tool calls outlast all but cost, a clean tool count goes right after think.
		const order = Object.entries(DESK_RANKS).sort(([, a], [, b]) => a - b).map(([group]) => group);
		expect(order).toEqual(["memory", "think", "tools", "tokens", "latency", "turns", "toolErrors", "cost"]);
		// A session whose telemetry outgrows the narrowest desk: the memory estimate goes first.
		git();
		const huge = { calls: 12_345, turns: 1234, scale: 1000, startedMs: 1_000 * 3_600_000 };
		for (const errors of [1234, 0]) {
			const harness = await start(`desk-order-${errors}`, { branch: session({ ...huge, errors, cacheWrite: errors ? 0 : 18_000 }) });
			try {
				vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
				await stream(harness, 1000);
				const telemetry = (width: number) => strip(harness.getFooter()!.render(width).at(-2)!);
				expect(telemetry(400)).toContain("memory");
				const narrowest = telemetry(FOOTER_TIERS.deskMin);
				expect(narrowest).not.toContain("memory");
				for (const kept of ["think", "↑ 65M", "300.0s", "# 1234", "$750.00", "⚙ 12345"]) expect(narrowest).toContain(kept);
				if (errors) expect(narrowest).toContain("✕ 1234 (10.0%)");
				for (let width = 400; width >= FOOTER_TIERS.deskMin; width--) {
					const row = telemetry(width);
					expect(visibleWidth(row), `${width}`).toBeLessThanOrEqual(width);
					expect(harness.getFooter()!.render(width), `${width}`).toHaveLength(3);
				}
			} finally {
				vi.unstubAllEnvs();
				harness.disposeFooter();
			}
		}
	});

	it("keeps a laptop's essentials on one row and leaves out the diagnostics at 150 columns", async () => {
		git();
		const harness = await start("laptop-content", { keyedExtensionStatuses: { herder: "herder: T2 integrate · 3/5 tasks" } });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await stream(harness);
			const lines = harness.getFooter()!.render(150).map(strip);
			expect(lines).toHaveLength(3);
			expect(lines[1]).toContain("herder: T2 integrate · 3/5 tasks");
			const essentials = lines[2]!;
			expect(essentials.startsWith(" ╰ ")).toBe(true);
			// Git, then cost, then turns and elapsed, then failed tool calls; latency, throughput, cache, and path on the right.
			const left = ["⎇ main  +42 −17  ↑ 2  ↓ 1", "$0.750", "# 2  ◷ 1h 00m", "✕ 1 (50.0%)"];
			const right = ["⏱ 300ms  » 133 tok/s", "⚡ 65%", "⌂ /tmp/project"];
			const positions = [...left, ...right].map(fact => essentials.indexOf(fact));
			expect(positions.every(index => index >= 0), essentials).toBe(true);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			for (const absent of ["⇄", "↺", "/turn", "↑ 65k", "↓ 31k", "120k", "memory", "think", "edited", "⚙"]) {
				expect(essentials).not.toContain(absent);
			}
			// Without failures the tool count stays out too.
			const clean = await start("laptop-clean", { branch: session({ errors: 0 }) });
			try {
				const row = strip(clean.getFooter()!.render(150).at(-1)!);
				expect(row).not.toContain("✕");
				expect(row).not.toContain("⚙");
			} finally {
				clean.disposeFooter();
			}
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("shows price unavailable where a laptop's cost goes", async () => {
		const harness = await start("laptop-unpriced", {
			model: { id: "gpt-6.1-terra", provider: "magpie", reasoning: true, magpiePricing: "unavailable" },
		});
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const row = strip(harness.getFooter()!.render(150).at(-1)!);
			expect(row).toContain("main");
			expect(row.indexOf("price unavailable")).toBeGreaterThan(row.indexOf("main"));
			expect(row).not.toContain("$0.750");
			expect(strip(harness.getFooter()!.render(50)[0]!)).toContain("price?");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("drops a laptop's groups cache first and Git last, with failed tool calls outlasting all but Git", async () => {
		git();
		const harness = await start("laptop-order");
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await stream(harness);
			const markers = { cache: "⚡", latency: "»", turns: "#", cwd: "⌂", cost: "$0.750", errors: "✕", git: "⎇ main" };
			const narrowest: Record<string, number> = {};
			for (let width = 174; width >= FOOTER_TIERS.phoneMax + 1; width--) {
				const lines = harness.getFooter()!.render(width).map(strip);
				expect(lines, `${width}`).toHaveLength(2);
				const row = lines[1]!;
				expect(visibleWidth(row), `${width}`).toBeLessThanOrEqual(width);
				for (const [group, marker] of Object.entries(markers)) if (row.includes(marker)) narrowest[group] = width;
			}
			const order = Object.keys(markers).map(group => narrowest[group]!);
			// Every group fits at 174; under pressure they leave in rank order, and Git always stays.
			expect(order.every(width => width > 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => b - a));
			expect(narrowest.git).toBe(FOOTER_TIERS.phoneMax + 1);
			expect(Object.entries(LAPTOP_RANKS).sort(([, a], [, b]) => a - b).map(([group]) => group)).toEqual(Object.keys(markers));
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
		// A long branch leaves room for one more group beside Git: the failed tool calls, not the cost.
		const crowded = await start("laptop-order-branch", { gitBranch: "feature/responsive-footer-tiers" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const row = strip(crowded.getFooter()!.render(FOOTER_TIERS.phoneMax + 1).at(-1)!);
			expect(row).toContain("⎇ feature/responsive-footer-tiers");
			expect(row).toContain("✕ 1 (50.0%)");
			expect(row).not.toContain("$0.750");
		} finally {
			vi.unstubAllEnvs();
			crowded.disposeFooter();
		}
	});

	it("draws the phone row as plain text without Nerd Font glyphs, bands, or caps", async () => {
		const theme = {
			fg: (_token: string, text: string) => `\x1b[38;2;200;200;200m${text}\x1b[39m`,
			bg: (_token: string, text: string) => `\x1b[48;2;58;59;64m${text}\x1b[49m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		};
		const harness = await start("phone-plain", { theme, thinkingLevel: "medium" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			for (let width = 20; width <= FOOTER_TIERS.phoneMax; width++) {
				const lines = harness.getFooter()!.render(width);
				expect(lines, `${width}`).toHaveLength(1);
				expect(lines[0], `${width}`).not.toMatch(PRIVATE_USE);
				expect(lines[0], `${width}`).not.toContain("\x1b[48;");
				expect(lines[0], `${width}`).not.toMatch(/[━╸─]/);
			}
			expect(strip(harness.getFooter()!.render(50)[0]!)).toBe(" opus-5-5 · MEDIUM · 42.5% · $0.750");
			// The thinking level keeps its color.
			expect(harness.getFooter()!.render(50)[0]).toContain(renderThinking(theme as unknown as Parameters<typeof renderThinking>[0], "medium"));
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("shows only attention and problem statuses on the phone row, problems first", async () => {
		const harness = await start("phone-alerts", { keyedExtensionStatuses: {
			autoresearch: "research 2/5", goal: "goal: ship the tiers", subagents: "subagents: on",
			representative: "📣 rep #dev", "relay-rooms": "#dev #ops", "magpie-quota": "quota awaiting · retry in 2h 10m",
		} });
		try {
			harness.setStatus(PROCESS_STATUS_KEY, "bg 2 running · 1 failed");
			const row = () => strip(harness.getFooter()!.render(FOOTER_TIERS.phoneMax)[0]!);
			expect(row()).toBe(" opus-5-5 · HIGH · 42.5% · $0.750 · bg 1 failed · quota awaiting");
			for (const routine of ["research", "goal", "subagents", "rep", "#dev", "running"]) expect(row()).not.toContain(routine);
			harness.setStatus("herder", "herder: T2 verify blocked · 3/5 tasks");
			// Problems first, then attention; what does not fit drops from the end.
			expect(row()).toBe(" opus-5-5 · HIGH · 42.5% · $0.750 · herder blocked · bg 1 failed");
			harness.setStatus("goal", "↻ paused");
			harness.setStatus("herder");
			harness.setStatus(PROCESS_STATUS_KEY);
			expect(row()).toBe(" opus-5-5 · HIGH · 42.5% · $0.750 · quota awaiting · goal paused");
			harness.setStatus("magpie-quota");
			harness.setStatus("goal");
			expect(row()).toBe(" opus-5-5 · HIGH · 42.5% · $0.750");
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps the model and context percentage on a narrow phone, cutting the model before the percentage", async () => {
		const harness = await start("phone-narrow", { keyedExtensionStatuses: { herder: "herder: T2 verify blocked" } });
		try {
			expect(strip(harness.getFooter()!.render(30)[0]!)).toBe(" opus-5-5 · HIGH · 42.5%");
			expect(strip(harness.getFooter()!.render(20)[0]!)).toBe(" opus-5-5 · 42.5%");
			expect(strip(harness.getFooter()!.render(14)[0]!)).toBe(" opus… · 42.5%");
			for (let width = 8; width <= FOOTER_TIERS.phoneMax; width++) {
				const line = strip(harness.getFooter()!.render(width)[0]!);
				expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
				expect(line, `${width}`).toContain("42.5%");
				if (width >= 12) expect(line, `${width}`).toMatch(/^ o/);
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it.each([100, 193])("holds the row count at %s columns while Git settles and metrics arrive", async (width) => {
		const pending = git(true);
		const harness = await start(`tier-steady-${width}`, { branch: session({ errors: 0 }) });
		try {
			const rows = harness.getFooter()!.render(width);
			expect(strip(rows.join("\n"))).toContain("git …");
			pending.release();
			const dirty = harness.getFooter()!.render(width);
			expect(strip(dirty.join("\n"))).toContain("+42");
			await stream(harness);
			const measured = harness.getFooter()!.render(width);
			expect(strip(measured.join("\n"))).toContain("tok/s");
			expect(new Set([rows.length, dirty.length, measured.length]).size).toBe(1);
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps the last Git stats painted while a later refresh is pending", async () => {
		const pending = git(true);
		const harness = await start("git-second-refresh");
		try {
			const render = () => strip(harness.getFooter()!.render(193).join("\n"));
			expect(render()).toContain("git …");
			pending.release();
			expect(render()).toContain("+42");
			const calls = vi.mocked(execFile).mock.calls.length;
			const later = Date.now() + 15_000;
			vi.spyOn(Date, "now").mockImplementation(() => later);
			const refreshing = render();
			expect(vi.mocked(execFile).mock.calls.length).toBe(calls + 3);
			expect(refreshing).toContain("+42");
			expect(refreshing).not.toContain("git …");
			pending.release();
			expect(render()).toContain("+42");
		} finally {
			harness.disposeFooter();
		}
	});
});

describe("statusline footer cache lens", () => {
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

	function branchWithCache(cacheRead: number, input = 1000, cacheWrite = 0) {
		return [
			{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() - 60_000, content: [{ type: "text", text: "hi" }] } },
			{
				id: "a1",
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet-4",
					content: [],
					usage: { input, output: 200, cacheRead, cacheWrite, totalTokens: input + 200 + cacheRead + cacheWrite, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
				},
			},
		];
	}

	function anthropicPayload(systemText: string, tools = [{ name: "read", input_schema: { type: "object" } }], messages = [{ role: "user", content: "hi" }]) {
		return {
			model: "claude-sonnet-4",
			system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral", ttl: "5m" } }],
			tools,
			messages,
		};
	}

	function assistantUsageEnd(usage: { input: number; output?: number; cacheRead: number; cacheWrite?: number }, overrides: Record<string, unknown> = {}) {
		return {
			type: "message_end",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-sonnet-4",
				stopReason: "stop",
				usage: { input: usage.input, output: usage.output ?? 100, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite ?? 0 },
				...overrides,
			},
		};
	}

	it("preserves healthy desktop and laptop cache rendering without anomaly tags or extra status chips", async () => {
		const harness = createHarness("cache-lens-healthy", "tui", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
			branch: branchWithCache(9000, 1000, 0),
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await harness.emit("before_provider_request", { payload: anthropicPayload("Stable prompt") });
			await harness.emit("message_end", assistantUsageEnd({ input: 200, cacheRead: 0, cacheWrite: 5000 }));
			await harness.emit("before_provider_request", {
				payload: anthropicPayload("Stable prompt", undefined, [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "ok" },
					{ role: "user", content: "next" },
				]),
			});
			await harness.emit("message_end", assistantUsageEnd({ input: 200, cacheRead: 4800, cacheWrite: 0 }));

			const desk = strip(harness.getFooter()!.render(210).join("\n"));
			const laptop = strip(harness.getFooter()!.render(160).join("\n"));
			expect(desk).toContain("⚡ 9.0k 90%");
			expect(desk).not.toContain("(!");
			expect(laptop).toContain("⚡ 90%");
			expect(laptop).not.toContain("(!");
			expect(harness.ctx.ui.setStatus).not.toHaveBeenCalledWith("cache-lens", expect.anything());
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("surfaces (!sys) and (!tools) anomalies in desktop and laptop cache slots, including when session cacheRead === 0", async () => {
		// Case 1: session history already has cacheRead > 0
		const withReads = createHarness("cache-lens-anomaly-reads", "tui", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
			branch: branchWithCache(8000, 2000, 0),
			extensionStatuses: [],
		});
		statuslineFooter(withReads.pi);
		await withReads.emit("session_start", { type: "session_start", reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await withReads.emit("before_provider_request", { payload: anthropicPayload("System v1") });
			await withReads.emit("message_end", assistantUsageEnd({ input: 100, cacheRead: 0, cacheWrite: 5000 }));

			await withReads.emit("before_provider_request", { payload: anthropicPayload("System v2 changed") });
			await withReads.emit("message_end", assistantUsageEnd({ input: 200, cacheRead: 0, cacheWrite: 5200 }));

			const desk = strip(withReads.getFooter()!.render(210).join("\n"));
			const laptop = strip(withReads.getFooter()!.render(160).join("\n"));
			const phone = strip(withReads.getFooter()!.render(50).join("\n"));
			expect(desk).toContain("⚡ 8.0k 80%  ↺ 0% (!sys)");
			expect(laptop).toContain("⚡ 80% (!sys)");
			expect(phone).not.toContain("!sys");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			expect(strip(withReads.getFooter()!.render(210).join("\n"))).toContain("\u{F140B} 8.0k 80%  \u{F02DA} 0% (!sys)");

			// Mutate tools on next call -> switches badge to (!tools)
			await withReads.emit("before_provider_request", {
				payload: anthropicPayload("System v2 changed", [
					{ name: "read", input_schema: { type: "object" } },
					{ name: "write", input_schema: { type: "object" } },
				]),
			});
			await withReads.emit("message_end", assistantUsageEnd({ input: 200, cacheRead: 1000, cacheWrite: 4000 }));
			expect(strip(withReads.getFooter()!.render(210).join("\n"))).toContain("19% (!tools)");
			expect(strip(withReads.getFooter()!.render(160).join("\n"))).toContain("80% (!tools)");
		} finally {
			vi.unstubAllEnvs();
			withReads.disposeFooter();
		}

		// Case 2: session cacheRead === 0 (never had a hit yet) still surfaces the anomaly in ⚡ slot
		const zeroReads = createHarness("cache-lens-anomaly-zero", "tui", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
			branch: branchWithCache(0, 5000, 0),
			extensionStatuses: [],
		});
		statuslineFooter(zeroReads.pi);
		await zeroReads.emit("session_start", { type: "session_start", reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await zeroReads.emit("before_provider_request", { payload: anthropicPayload("System A") });
			await zeroReads.emit("message_end", assistantUsageEnd({ input: 5000, cacheRead: 0, cacheWrite: 0 }));

			await zeroReads.emit("before_provider_request", { payload: anthropicPayload("System B") });
			await zeroReads.emit("message_end", assistantUsageEnd({ input: 5100, cacheRead: 0, cacheWrite: 0 }));

			const desk = strip(zeroReads.getFooter()!.render(210).join("\n"));
			const laptop = strip(zeroReads.getFooter()!.render(160).join("\n"));
			expect(desk).toContain("⚡ 0% (!sys)");
			expect(laptop).toContain("⚡ 0% (!sys)");
		} finally {
			vi.unstubAllEnvs();
			zeroReads.disposeFooter();
		}
	});

	it("handles /cache, /cache anomalies, /cache reset, and invalid args cleanly", async () => {
		const harness = createHarness("cache-lens-commands", "tui", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
			branch: branchWithCache(0, 5000, 0),
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await harness.emit("before_provider_request", { payload: anthropicPayload("System initial") });
			await harness.emit("message_end", assistantUsageEnd({ input: 100, cacheRead: 0, cacheWrite: 5000 }));
			await harness.emit("before_provider_request", { payload: anthropicPayload("System mutated!") });
			await harness.emit("message_end", assistantUsageEnd({ input: 100, cacheRead: 0, cacheWrite: 5100 }));

			await harness.runCommand("cache", "");
			expect(harness.notifications.at(-1)).toContain("Prefix cache:");
			expect(harness.notifications.at(-1)).toContain("system_mutated");
			expect(harness.notifications.at(-1)).toContain("char@7 byte@7");

			await harness.runCommand("cache", "anomalies");
			expect(harness.notifications.at(-1)).toContain("Prefix cache anomalies (1 of 2 calls");
			expect(harness.notifications.at(-1)).toContain("!sys");

			await harness.runCommand("cache", "bogus");
			expect(harness.notifications.at(-1)).toContain("usage: /cache [anomalies|reset]");

			await harness.runCommand("cache", "reset");
			expect(harness.notifications.at(-1)).toContain("reset");
			expect(strip(harness.getFooter()!.render(210).join("\n"))).not.toContain("!sys");

			await harness.runCommand("cache", "summary");
			expect(harness.notifications.at(-1)).toContain("no LLM calls recorded");

			expect(harness.pi.appendEntry).toHaveBeenCalledWith("pi-extensions.command", {
				command: "cache",
				kind: "extension",
				extension: "statusline-footer",
			});
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("isolates TUI cache-lens diagnostics from print-mode child sessions and never persists prompt text on reload", async () => {
		const secretSystem = "SUPER_SECRET_SYSTEM_INSTRUCTIONS_XYZ";
		const tui = createHarness("cache-lens-isolation", "tui", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
			branch: branchWithCache(8000, 2000, 0),
			extensionStatuses: [],
		});
		const child = createHarness("cache-lens-isolation", "print", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
		});
		statuslineFooter(tui.pi);
		statuslineFooter(child.pi);
		await tui.emit("session_start", { type: "session_start", reason: "startup" });
		await child.emit("session_start", { type: "session_start", reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await tui.emit("before_provider_request", { payload: anthropicPayload(secretSystem) });
			await tui.emit("message_end", assistantUsageEnd({ input: 100, cacheRead: 0, cacheWrite: 5000 }));

			// Child print-mode session mutates system prompt and gets 0% hit — must NOT contaminate parent TUI!
			await child.emit("before_provider_request", { payload: anthropicPayload("CHILD SUBAGENT PROMPT") });
			await child.emit("message_end", assistantUsageEnd({ input: 5000, cacheRead: 0, cacheWrite: 0 }));

			expect(strip(tui.getFooter()!.render(210).join("\n"))).not.toContain("!sys");
			await tui.runCommand("cache", "anomalies");
			expect(tui.notifications.at(-1)).toContain("no cache anomalies");

			// Reload snapshot must not contain raw system prompt text
			tui.disposeFooter();
			await tui.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
			const reloadEntry = tui.entries.find((e: any) => e.customType === "statusline-footer:reload");
			expect(reloadEntry).toBeDefined();
			expect(JSON.stringify(reloadEntry)).not.toContain(secretSystem);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("statusline footer visual & live signal overhaul", () => {
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const rgbTheme = (colors: Record<string, string> = {}, surface: string | null = "#3a3b40") => {
		const hex = (value: string) => ({
			r: Number.parseInt(value.slice(1, 3), 16),
			g: Number.parseInt(value.slice(3, 5), 16),
			b: Number.parseInt(value.slice(5, 7), 16),
		});
		const fgCode = (v: string) => {
			const { r, g, b } = hex(v);
			return `\x1b[38;2;${r};${g};${b}m`;
		};
		const bgCode = (v: string) => {
			const { r, g, b } = hex(v);
			return `\x1b[48;2;${r};${g};${b}m`;
		};
		const palette: Record<string, string> = {
			accent: "#b48ead",
			text: "#e0e0e0",
			muted: "#a0a0a8",
			dim: "#45464b",
			borderMuted: "#5c5d63",
			success: "#7dcea0",
			warning: "#f5b041",
			error: "#e06c5f",
			syntaxFunction: "#3fa7b5",
			thinkingHigh: "#9aa5ce",
			...colors,
		};
		return {
			fg: (token: string, text: string) => `${fgCode(palette[token] ?? "#909090")}${text}\x1b[39m`,
			bg: (_token: string, text: string) => `${surface ? bgCode(surface) : "\x1b[49m"}${text}\x1b[49m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		};
	};

	it("renders sub-cell track gradientBar with compaction notch and keeps unfilled track subtle on powerline band", async () => {
		const plain = strip(gradientBar(25, 10));
		expect(plain).toBe("━━╸───────");
		expect(visibleWidth(plain)).toBe(10);

		const withNotch = strip(gradientBar(25, 10, undefined, { thresholdPct: 80 }));
		expect(withNotch).toBe("━━╸────▕──");

		// No notch when width < 8
		expect(strip(gradientBar(50, 6, undefined, { thresholdPct: 80 }))).not.toContain("▕");

		// Warning color on notch when pct >= thresholdPct - 5
		const theme = rgbTheme() as unknown as Parameters<typeof gradientBar>[2];
		const nearBar = gradientBar(76, 10, theme, { thresholdPct: 80 });
		expect(nearBar).toContain("\x1b[38;2;245;176;65m▕");

		// On a powerline surface, reband() preserves the calibrated unfilled track contrast (< 3:1) instead of lifting it
		const harness = createHarness("track-contrast", "tui", {
			model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
			contextUsage: { percent: 25, tokens: 25_000, contextWindow: 100_000 },
			theme: rgbTheme(),
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const bar = harness.getFooter()!.render(140)[0]!;
			const match = /\x1b\[48;2;58;59;64m\x1b\[38;2;(\d+);(\d+);(\d+)m─/.exec(bar);
			expect(match).not.toBeNull();
			const [r, g, b] = match!.slice(1).map(Number) as [number, number, number];
			expect(contrastRatio({ r, g, b }, { r: 58, g: 59, b: 64 })).toBeLessThan(3);
			// thinkingHigh uses theme token when available, not hardcoded #afb9fe
			expect(bar).toContain("\x1b[38;2;154;165;206mHIGH");
			expect(bar).not.toContain("175;185;254");
		} finally {
			harness.disposeFooter();
		}
	});

	it("omits zero-value and placeholder clutter across identity, desk, and laptop rows", async () => {
		const harness = createHarness("zero-omissions", "tui", {
			model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
			branch: [
				{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() - 60_000 } },
				{
					id: "a1",
					type: "message",
					message: {
						role: "assistant",
						provider: "anthropic",
						usage: { input: 5_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
						content: [],
					},
				},
			],
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const [bar, telemetry] = harness.getFooter()!.render(200).map(strip);
			expect(bar).not.toContain("0×");
			expect(telemetry).not.toContain("/turn");
			expect(telemetry).not.toContain("⚙");
			expect(telemetry).not.toContain("✓ 0");
			expect(telemetry).not.toContain("—");
			expect(telemetry).not.toContain("»");

			// Laptop omits latency placeholders as well
			const [, essentials] = harness.getFooter()!.render(120).map(strip);
			expect(essentials).not.toContain("—");
			expect(essentials).not.toContain("»");

			// With tool calls > 0 and errors === 0, show ⚙ N without ✓ 0
			const withTools = createHarness("zero-errors-with-tools", "tui", {
				branch: [
					{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() } },
					{
						id: "a1",
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 100, output: 50, cacheRead: 0, cost: { total: 0.01 } },
							content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
						},
					},
				],
				extensionStatuses: [],
			});
			statuslineFooter(withTools.pi);
			await withTools.emit("session_start", { reason: "startup" });
			const [, toolsTelemetry] = withTools.getFooter()!.render(200).map(strip);
			expect(toolsTelemetry).toContain("⚙ 1");
			expect(toolsTelemetry).not.toContain("✓ 0");
			withTools.disposeFooter();
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("tracks live running phases in the centered middle pill with cute icons, ignores nested tool calls, respects isIdle(), and shows phone live/queued indicators", async () => {
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("live-phases", "tui", {
			model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
			theme: rgbTheme(),
			sessionName: "my-feature-branch",
			isIdle: false,
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const bar = () => strip(harness.getFooter()!.render(160)[0]!);
			const phone = () => strip(harness.getFooter()!.render(60)[0]!);

			// waiting: cute filling orb + centered between provider and context
			await harness.emit("before_provider_request", { payload: {} });
			const waiting0 = bar();
			expect(waiting0).toContain("◌ waiting");
			expect(waiting0).not.toContain("waiting 0s");
			expect(waiting0.indexOf("(anthropic)")).toBeLessThan(waiting0.indexOf("◌ waiting"));
			expect(waiting0.indexOf("◌ waiting")).toBeLessThan(waiting0.indexOf("%"));
			// busy phase takes center stage over the idle session title
			expect(waiting0).not.toContain("my-feature-branch");

			now = 24_000; // tick 14 -> 14 % 4 === 2 ("◑")
			expect(bar()).toContain("◑ waiting 14s");
			expect(phone()).toContain("● 14s · opus-5-5");

			// thinking: twinkling star
			await harness.emit("message_update", {
				assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
			});
			now = 46_000; // tick 22 -> 22 % 4 === 2 ("✶")
			expect(bar()).toContain("✶ thinking 22s");

			// streaming (even though firstTokenAt was already set during thinking!)
			await harness.emit("message_update", {
				assistantMessageEvent: { type: "text_delta", delta: "answer" },
			});
			now = 54_000;
			expect(bar()).toContain("✎ writing 8s");

			// Nerd Fonts powerline pill uses rounded half-circle caps (E0B6 / E0B4)
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			const nerdBar = strip(harness.getFooter()!.render(160)[0]!);
			expect(nerdBar).toContain("\u{E0B6} ✎ writing 8s \u{E0B4}");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");

			// tool execution with per-tool cute icons
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "t-bash",
				toolName: "bash",
				args: {},
			});
			now = 56_000;
			expect(bar()).toContain("❯ bash 2s");

			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "very_long_tool_name_here",
				args: {},
			});
			now = 121_000;
			expect(bar()).toContain("⚙ very_long_too… 1m05s");

			// nested tool call (parentToolCallId set) must be ignored
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "t-child",
				toolName: "bash",
				parentToolCallId: "t1",
				args: {},
			});
			expect(bar()).toContain("very_long_too…");
			expect(bar()).not.toContain("bash");

			await harness.emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "t-child",
				toolName: "bash",
				parentToolCallId: "t1",
				result: {},
				isError: false,
			});
			expect(bar()).toContain("very_long_too…");

			// phone and centered pill both show queued alongside active phase
			harness.setPendingMessages(true);
			expect(bar()).toContain("⚙ very_long_too… 1m05s · queued");
			expect(phone()).toContain("● 1m05s · queued · opus-5-5");

			// ctx.isIdle() true switches center pill cleanly to queued/ready (never showing session title)
			harness.setIsIdle(true);
			expect(bar()).not.toContain("very_long_too…");
			expect(bar()).not.toContain("my-feature-branch");
			expect(bar()).toContain("◔ queued");
			expect(phone()).not.toContain("●");
			expect(phone()).toContain("queued · opus-5-5");

			harness.setPendingMessages(false);
			expect(bar()).toContain("◦ ready");

			harness.setIsIdle(false);
			await harness.emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "very_long_tool_name_here",
				result: {},
				isError: false,
			});
			expect(bar()).not.toContain("very_long_too…");
			expect(bar()).toContain("working");
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("tints the centered state pill lightly by phase on dark and light surfaces while keeping ready neutral", async () => {
		const darkSurface = { r: 0x39, g: 0x3a, b: 0x40 };
		const lightSurface = { r: 0xe6, g: 0xe6, b: 0xeb };
		const amber = { r: 0xc9, g: 0xc0, b: 0x44 };
		// Dark surface uses 19% mix, light surface uses softer 14% mix
		const darkAmber = pillTintSurface(darkSurface, amber);
		const lightAmber = pillTintSurface(lightSurface, amber);
		expect(darkAmber.r).toBeGreaterThan(darkSurface.r);
		expect(darkAmber.r).toBeLessThan(amber.r);
		expect(lightAmber.b).toBeLessThan(lightSurface.b);
		expect(lightAmber.b).toBeGreaterThan(amber.b);

		const theme = rgbTheme({
			warning: "#c9c044",
			thinkingHigh: "#bb69c7",
			success: "#58be95",
			syntaxVariable: "#5faec7",
			mdLink: "#6699ee",
		}, "#393a40");
		const harness = createHarness("pill-tints", "tui", {
			model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
			theme,
			isIdle: true,
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			const pillCapAndBg = () => {
				const row = harness.getFooter()!.render(160)[0]!;
				const match = /\x1b\[38;2;(\d+;\d+;\d+)m\uE0B6\x1b\[0m\x1b\[48;2;(\d+;\d+;\d+)m/.exec(row);
				expect(match, `expected tinted/neutral rounded pill in ${JSON.stringify(row)}`).not.toBeNull();
				// Left round cap foreground must match the pill fill background seamlessly
				expect(match![1]).toBe(match![2]);
				return match![2]!;
			};

			// Idle ready: stays on the exact neutral band surface (#393a40 -> 57;58;64)
			const readyBg = pillCapAndBg();
			expect(readyBg).toBe("57;58;64");

			// Waiting: warm amber tint
			harness.setIsIdle(false);
			await harness.emit("before_provider_request", { payload: {} });
			const waitingBg = pillCapAndBg();

			// Thinking: soft lavender tint
			await harness.emit("message_update", {
				assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
			});
			const thinkingBg = pillCapAndBg();

			// Writing: soft mint tint
			await harness.emit("message_update", {
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
			});
			const writingBg = pillCapAndBg();

			// Tool: soft sky-blue tint (distinct from amber waiting)
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: {},
			});
			const toolBg = pillCapAndBg();

			// All 5 states (ready, waiting, thinking, writing, tool) have distinct pill backgrounds
			expect(new Set([readyBg, waitingBg, thinkingBg, writingBg, toolBg]).size).toBe(5);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("adapts refresh timer cadence between 1s (active/warmth) and 30s (idle)", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness("adaptive-timer", "tui", { isIdle: true });
			statuslineFooter(harness.pi);
			await harness.emit("session_start", { reason: "startup" });
			harness.requestRender.mockClear();
			expect(vi.getTimerCount()).toBe(1);

			// Idle: does not fire at 1s, fires at 30s
			await vi.advanceTimersByTimeAsync(1_000);
			expect(harness.requestRender).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(29_000);
			expect(harness.requestRender).toHaveBeenCalledTimes(1);

			// Active: switches to 1s cadence immediately
			harness.setIsIdle(false);
			harness.getFooter()!.render(120);
			harness.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(harness.requestRender).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);

			harness.disposeFooter();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows prompt cache warmth countdown with warning under 60s and hides when expired", async () => {
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const harness = createHarness("cache-warmth", "tui", {
			model: { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages", reasoning: true },
			theme: rgbTheme(),
			branch: [
				{ id: "u1", type: "message", message: { role: "user", timestamp: now } },
				{
					id: "a1",
					type: "message",
					message: {
						role: "assistant",
						provider: "anthropic",
						usage: { input: 2_000, output: 200, cacheRead: 8_000, cacheWrite: 0, cost: { total: 0.02 } },
					},
				},
			],
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			await harness.emit("before_provider_request", {
				payload: {
					model: "claude-sonnet-4",
					system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
					messages: [{ role: "user", content: "hi" }],
				},
			});
			await harness.emit("message_end", {
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet-4",
					api: "anthropic-messages",
					stopReason: "stop",
					usage: { input: 200, output: 100, cacheRead: 8000, cacheWrite: 0 },
				},
			});

			// Default ephemeral TTL is 290s; advance 98s -> 192s = 3m12s remaining (dim)
			now += 98_000;
			const deskActive = harness.getFooter()!.render(210)[1]!;
			const laptopActive = harness.getFooter()!.render(130)[1]!;
			expect(strip(deskActive)).toContain("⚡ 8.0k 80% · 3m12s");
			expect(strip(laptopActive)).toContain("⚡ 80% · 3m12s");
			expect(deskActive).toContain("\x1b[38;2;69;70;75m3m12s");

			// Under 60s remaining -> warning color
			now += 150_000; // 42s left
			const deskWarn = harness.getFooter()!.render(210)[1]!;
			expect(strip(deskWarn)).toContain("⚡ 8.0k 80% · 42s");
			expect(deskWarn).toContain("\x1b[38;2;245;176;65m42s");

			// Expired -> countdown omitted cleanly
			now += 60_000;
			const deskExpired = strip(harness.getFooter()!.render(210)[1]!);
			expect(deskExpired).toContain("⚡ 8.0k 80%");
			expect(deskExpired).not.toContain("· 0s");
			expect(deskExpired).not.toMatch(/⚡ 8\.0k 80% ·/);
		} finally {
			vi.unstubAllEnvs();
			harness.disposeFooter();
		}
	});

	it("displays last-turn context delta on Desk with warning at >=20k and hides <5k or on compaction", async () => {
		const harness = createHarness("context-delta", "tui", {
			model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
			contextUsage: { percent: 30, tokens: 30_000, contextWindow: 100_000 },
			theme: rgbTheme(),
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			// Baseline turn
			await harness.emit("message_end", assistantEnd(100));
			expect(strip(harness.getFooter()!.render(200)[0]!)).not.toContain("+");

			// +3k (< 5k) hidden
			harness.setContextUsage({ percent: 33, tokens: 33_000, contextWindow: 100_000 });
			await harness.emit("message_end", assistantEnd(100));
			expect(strip(harness.getFooter()!.render(200)[0]!)).not.toContain("+3");

			// +12k shown on Desk in dim (lifted on band), omitted on Laptop
			harness.setContextUsage({ percent: 45, tokens: 45_000, contextWindow: 100_000 });
			await harness.emit("message_end", assistantEnd(100));
			const desk12 = harness.getFooter()!.render(200)[0]!;
			expect(strip(desk12)).toContain("45k/100k +12k");
			expect(desk12).not.toContain("\x1b[38;2;245;176;65m+12k");
			expect(strip(harness.getFooter()!.render(130)[0]!)).not.toContain("+12k");

			// +25k (>= 20k) shown in warning color
			harness.setContextUsage({ percent: 70, tokens: 70_000, contextWindow: 100_000 });
			await harness.emit("message_end", assistantEnd(100));
			const desk25 = harness.getFooter()!.render(200)[0]!;
			expect(strip(desk25)).toContain("70k/100k +25k");
			expect(desk25).toContain("\x1b[38;2;245;176;65m+25k");

			// Compaction clears delta
			await harness.emit("session_compact", { type: "session_compact" });
			expect(strip(harness.getFooter()!.render(200)[0]!)).not.toContain("+25k");
		} finally {
			harness.disposeFooter();
		}
	});

	it("renders Pi native full-width input rules in quiet borderMuted, suppresses generic Working..., keeps special/custom indicators, and shows muted top-right session title", async () => {
		// Pure helper: generic Working status detection vs special/custom notices
		expect(isGenericWorkingStatus("⠋ Working")).toBe(true);
		expect(isGenericWorkingStatus("⠋ Working...")).toBe(true);
		expect(isGenericWorkingStatus("⠋ Working…")).toBe(true);
		expect(isGenericWorkingStatus("⠋ Working (esc to interrupt)")).toBe(true);
		expect(isGenericWorkingStatus("\x1b[35m⠋ Working... (esc to interrupt)\x1b[39m")).toBe(true);
		expect(isGenericWorkingStatus("⠋ Compacting context... (esc to cancel)")).toBe(false);
		expect(isGenericWorkingStatus("⠋ Retrying (1/3) in 3s... (esc to cancel)")).toBe(false);
		expect(isGenericWorkingStatus("⠋ Summarizing branch... (esc to cancel)")).toBe(false);
		expect(isGenericWorkingStatus("⠋ Spokesman (kimi) rewriting…")).toBe(false);
		expect(isGenericWorkingStatus("⠋ Working on migration")).toBe(false);

		// Pure helper: idle border, working top-left border, separate title color, narrow fallback
		const color = (s: string) => `\x1b[38;2;90;95;110m${s}\x1b[39m`;
		const mutedTitle = (s: string) => `\x1b[38;2;160;160;168m${s}\x1b[39m`;
		const idle = embedRightBorderTitle(color("─".repeat(80)), 80, "  refactor\nfooter   layout  ", color, mutedTitle);
		expect(visibleWidth(idle)).toBe(80);
		expect(strip(idle)).toMatch(/^─+ refactor footer layout ──$/);
		expect(idle).toContain("\x1b[38;2;160;160;168mrefactor footer layout");

		const workingBase = `${color("── ")}⠋ Working... (esc to interrupt)${color(` ${"─".repeat(45)}`)}`;
		const withWorking = embedRightBorderTitle(workingBase, 80, "Improve statusline-footer", color, mutedTitle);
		expect(visibleWidth(withWorking)).toBe(80);
		expect(strip(withWorking)).toMatch(/^── ⠋ Working\.\.\. \(esc to interrupt\) ─+ Improve statusline-footer ──$/);

		// Narrow border with no room beside Working... leaves base untouched
		const tightBase = `${color("── ")}⠋ Working... (esc to interrupt)${color(" ───────")}`;
		expect(embedRightBorderTitle(tightBase, visibleWidth(tightBase), "Title", color)).toBe(tightBase);

		// Extension wires TitledEditor on startup, repaints on session_info_changed, keeps footer center as state pill, and restores on /footer off
		let editorFactory: any;
		const theme = rgbTheme({
			borderMuted: "#5c5d63",
			muted: "#a0a0a8",
			thinkingHigh: "#b48ead",
			bashMode: "#4ec990",
		});
		const powerline = createHarness("session-name-editor", "tui", {
			model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true },
			sessionName: "  refactor\nfooter   layout  ",
			theme,
			extensionStatuses: [],
		});
		(powerline.ctx.ui as any).theme = theme;
		(powerline.ctx.ui as any).getEditorComponent = () => editorFactory;
		(powerline.ctx.ui as any).setEditorComponent = vi.fn((factory: any) => { editorFactory = factory; });

		statuslineFooter(powerline.pi);
		await powerline.emit("session_start", { reason: "startup" });
		try {
			// Footer center consistently shows current state ("◦ ready"), not the session title
			const wide = strip(powerline.getFooter()!.render(200)[0]!);
			expect(wide).toContain("◦ ready");
			expect(wide).not.toContain("refactor footer layout");
			expect(visibleWidth(wide)).toBe(200);

			// Custom editor keeps Pi's native top rule in quiet borderMuted + muted title, and drops the
			// redundant bottom rule on laptop/desk widths so the footer bar forms the single bottom edge.
			expect(editorFactory).toBeTypeOf("function");
			const thinkingColor = (s: string) => theme.fg("thinkingHigh", s);
			const editor = editorFactory(
				{ requestRender: vi.fn(), terminal: { rows: 20 } },
				{ borderColor: thinkingColor, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } },
				{ matches: () => false },
			);
			expect(editor.embedWorkingStatus).toBe(true);
			editor.setText("hello\nworld");
			const lines = editor.render(100);
			expect(lines).toHaveLength(3); // native top rule + 2 input lines (footer bar serves as bottom edge)
			for (const line of lines) expect(visibleWidth(line)).toBe(100);
			const stripAll = (s: string) => strip(s).replace(/\x1b_[^\x07]*\x07/g, "");
			expect(stripAll(lines[0]!)).toMatch(/^─+ refactor footer layout ──$/);
			expect(stripAll(lines[1]!)).toMatch(/^hello +$/);
			expect(stripAll(lines[2]!)).toMatch(/^world +$/);
			// Quiet borderMuted top rule + muted session title
			expect(lines[0]).toContain(theme.fg("borderMuted", " ──"));
			expect(lines[0]).toContain(theme.fg("muted", "refactor footer layout"));

			// Phone width (plain-text footer with no Powerline rule) keeps the quiet bottom rule
			const phoneLines = editor.render(60);
			expect(phoneLines).toHaveLength(4);
			expect(phoneLines[3]).toBe(theme.fg("borderMuted", "─".repeat(60)));

			// Scroll overflow keeps the bottom "↓ N more" indicator rule on desk/laptop
			editor.setText(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
			for (let k = 0; k < 12; k++) editor.handleInput("\x1b[A");
			const scrolled = editor.render(100);
			expect(stripAll(scrolled.at(-1)!)).toMatch(/^─+ ↓ \d+ more ─+$/);
			expect(visibleWidth(scrolled.at(-1)!)).toBe(100);
			editor.setText("hello\nworld");

			// Generic "Working..." is suppressed (covered by the footer's centered live pill), keeping top border clean
			const mutableWorking = {
				kind: "working",
				message: "Working",
				renderInBorder: () => thinkingColor(`⠋ ${mutableWorking.message}`),
				renderSpinnerInBorder: () => thinkingColor("⠋"),
			};
			editor.setWorkingStatusIndicator(mutableWorking);
			const genericTop = editor.render(100)[0]!;
			expect(visibleWidth(genericTop)).toBe(100);
			expect(strip(genericTop)).toMatch(/^─+ refactor footer layout ──$/);
			expect(strip(genericTop)).not.toContain("Working");

			// Custom setWorkingMessage() on the same working indicator (e.g., Spokesman rewriting) shows up immediately
			mutableWorking.message = "Spokesman (kimi) rewriting…";
			const customTop = editor.render(100)[0]!;
			expect(visibleWidth(customTop)).toBe(100);
			expect(strip(customTop)).toMatch(/^── ⠋ Spokesman \(kimi\) rewriting… ─+ refactor footer layout ──$/);
			expect(customTop).toContain(thinkingColor("⠋ Spokesman (kimi) rewriting…"));
			expect(customTop).toContain(theme.fg("borderMuted", "── "));

			// Special Pi indicators (compaction, retry, branch summary) stay visible with quiet border dashes
			editor.setWorkingStatusIndicator({
				kind: "compaction",
				renderInBorder: () => thinkingColor("⠋ Compacting context... (esc to cancel)"),
				renderSpinnerInBorder: () => thinkingColor("⠋"),
			});
			const compactTop = editor.render(100)[0]!;
			expect(visibleWidth(compactTop)).toBe(100);
			expect(strip(compactTop)).toMatch(/^── ⠋ Compacting context\.\.\. \(esc to cancel\) ─+ refactor footer layout ──$/);
			expect(compactTop).toContain(thinkingColor("⠋ Compacting context... (esc to cancel)"));
			editor.setWorkingStatusIndicator(undefined);

			// Bash mode keeps Pi's bashMode border color on top rule (and bottom rule when shown on phone)
			editor.borderColor = (s: string) => theme.fg("bashMode", s);
			const bashLines = editor.render(100);
			expect(bashLines).toHaveLength(3);
			expect(bashLines[0]).toContain(theme.fg("bashMode", " ──"));
			const bashPhoneLines = editor.render(60);
			expect(bashPhoneLines[3]).toBe(theme.fg("bashMode", "─".repeat(60)));

			// session_info_changed repaints and editor picks up the new title immediately
			powerline.requestRender.mockClear();
			powerline.setSessionName("new title");
			await powerline.emit("session_info_changed", { type: "session_info_changed" });
			expect(powerline.requestRender).toHaveBeenCalledTimes(1);
			expect(strip(editor.render(100)[0]!)).toMatch(/^─+ new title ──$/);

			// /footer off restores the default editor
			await powerline.runCommand("footer", "off");
			expect(editorFactory).toBeUndefined();
		} finally {
			powerline.disposeFooter();
		}
	});

	it("renders live swarm board progress counts instead of static swarm status and repaints on board updates", async () => {
		const sessionId = "swarm-live-board";
		const harness = createHarness(sessionId, "tui", {
			keyedExtensionStatuses: { swarm: "🐝 swarm" },
			extensionStatuses: [],
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		const registry = (globalThis as Record<symbol, any>)[SWARM_BOARDS];
		try {
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			expect(strip(harness.getFooter()!.render(160)[0]!)).toContain("swarm");
			expect(strip(harness.getFooter()!.render(160)[0]!)).not.toContain("🐝");

			const board = {
				version: 1,
				sessionId,
				updatedAt: Date.now(),
				cards: [
					{ status: "done" },
					{ status: "done" },
					{ status: "doing" },
					{ status: "todo" },
					{ status: "todo" },
				],
			};
			registry.boards.set(sessionId, board);
			harness.requestRender.mockClear();
			for (const listener of registry.listeners) listener(board);
			expect(harness.requestRender).toHaveBeenCalledTimes(1);
			expect(strip(harness.getFooter()!.render(160)[0]!)).toContain("swarm 2/5 · 1 doing");

			// Blocked card surfaces blocked count
			board.cards[2] = { status: "blocked" };
			expect(strip(harness.getFooter()!.render(160)[0]!)).toContain("swarm 2/5 · 1 blocked");

			// Cleanup on shutdown removes board listener
			harness.disposeFooter();
			await harness.emit("session_shutdown", { reason: "quit" });
			harness.requestRender.mockClear();
			for (const listener of registry.listeners) listener(board);
			expect(harness.requestRender).not.toHaveBeenCalled();
		} finally {
			registry?.boards?.delete(sessionId);
			vi.unstubAllEnvs();
		}
	});

	it("refreshes git diff stats immediately after mutating tools finish", async () => {
		let now = 100_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let gitCalls = 0;
		vi.mocked(execFile).mockImplementation(((_file: unknown, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
			if (args.includes("status")) {
				gitCalls++;
				cb(null, " M file.ts\n");
			} else if (args.includes("--shortstat")) {
				cb(null, ` 1 file changed, ${gitCalls} insertions(+)\n`);
			} else {
				cb(null, "0\t0\n");
			}
		}) as unknown as typeof execFile);

		const harness = createHarness("git-refresh-mutating", "tui", { extensionStatuses: [] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			// Initial render triggers first git refresh
			harness.getFooter()!.render(160);
			expect(gitCalls).toBe(1);

			// Non-mutating tool (`read`) within 15s throttle does NOT force git refresh
			now += 1_000;
			await harness.emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "read",
				result: {},
				isError: false,
			});
			harness.getFooter()!.render(160);
			expect(gitCalls).toBe(1);

			// Mutating tools (`edit`, `write`, `bash`) immediately invalidate gitStatAt
			for (const toolName of ["edit", "write", "bash"]) {
				const before = gitCalls;
				now += 1_000;
				await harness.emit("tool_execution_end", {
					type: "tool_execution_end",
					toolCallId: `t-${toolName}`,
					toolName,
					result: {},
					isError: false,
				});
				harness.getFooter()!.render(160);
				expect(gitCalls, toolName).toBe(before + 1);
			}
		} finally {
			harness.disposeFooter();
		}
	});

	it("keeps /footer session-local across new sessions, preserves mode on reload, and persists via /footer default", async () => {
		const first = createHarness("persist-mode-1", "tui");
		statuslineFooter(first.pi);
		await first.emit("session_start", { reason: "startup" });
		await first.runCommand("footer", "compact");

		// A fresh session still starts in the default "full" mode.
		const fresh = createHarness("persist-mode-fresh", "tui");
		statuslineFooter(fresh.pi);
		await fresh.emit("session_start", { reason: "startup" });
		expect(fresh.getFooter()!.render(200).length).toBeGreaterThan(1);
		fresh.disposeFooter();

		// Reloading the compact session preserves its mode through the reload snapshot.
		await first.emit("session_shutdown", { reason: "reload" });
		const reloaded = createHarness("persist-mode-1", "tui");
		reloaded.entries.push(...first.entries);
		statuslineFooter(reloaded.pi);
		await reloaded.emit("session_start", { reason: "reload" });
		expect(reloaded.getFooter()!.render(200)).toHaveLength(1);
		reloaded.disposeFooter();

		// /footer default persists the startup mode for new sessions.
		await first.runCommand("footer", "default compact");
		expect(first.notifications.at(-1)).toBe("Default footer mode for new sessions: compact");
		first.disposeFooter();

		const second = createHarness("persist-mode-2", "tui");
		statuslineFooter(second.pi);
		await second.emit("session_start", { reason: "startup" });
		expect(second.getFooter()!.render(200)).toHaveLength(1);

		await second.runCommand("footer", "default off");
		second.disposeFooter();

		const third = createHarness("persist-mode-3", "tui");
		statuslineFooter(third.pi);
		await third.emit("session_start", { reason: "startup" });
		expect(third.getFooter()).toBeUndefined();
	});

	it("opens the /cache overlay when ctx.ui.custom is available and falls back to notify otherwise", async () => {
		const customMock = vi.fn(async (factory: any, opts: any) => {
			expect(opts).toMatchObject({ overlay: true });
			let closed = false;
			const comp = factory(
				{ requestRender: vi.fn(), mode: "inline", terminal: { rows: 30 } },
				rgbTheme(),
				undefined,
				() => { closed = true; },
			);
			const lines = comp.render(100);
			expect(lines.some((l: string) => strip(l).includes("Prefix KV Cache"))).toBe(true);
			// Pressing 'r' triggers onReset which repaints footer
			comp.handleInput?.("r");
			comp.handleInput?.("q");
			expect(closed).toBe(true);
			return undefined;
		});

		const withOverlay = createHarness("cache-overlay-yes", "tui", { custom: customMock });
		statuslineFooter(withOverlay.pi);
		await withOverlay.emit("session_start", { reason: "startup" });
		withOverlay.requestRender.mockClear();
		await withOverlay.runCommand("cache", "");
		expect(customMock).toHaveBeenCalledTimes(1);
		expect(withOverlay.requestRender).toHaveBeenCalled();

		await withOverlay.runCommand("cache", "anomalies");
		expect(customMock).toHaveBeenCalledTimes(2);
		withOverlay.disposeFooter();

		// Without ctx.ui.custom, falls back to ctx.ui.notify
		const fallback = createHarness("cache-overlay-fallback", "tui");
		statuslineFooter(fallback.pi);
		await fallback.emit("session_start", { reason: "startup" });
		await fallback.runCommand("cache", "");
		expect(fallback.notifications.at(-1)).toContain("no LLM calls recorded");
		await fallback.runCommand("cache", "anomalies");
		expect(fallback.notifications.at(-1)).toContain("no cache anomalies");
		fallback.disposeFooter();
	});
});

describe("statusline footer three-row refinements", () => {
	const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const claude = { id: "claude-opus-5-5", provider: "anthropic", reasoning: true };
	const powerlineTheme = {
		fg: (_token: string, text: string) => text,
		bg: (token: string, text: string) => (token === "toolPendingBg" ? `\x1b[48;2;40;40;46m${text}\x1b[49m` : text),
		bold: (text: string) => text,
	};

	it("deduplicates left ● and queued when the center state pill fits and falls back when narrow", async () => {
		for (const [skinName, theme] of [["flat", undefined], ["powerline", powerlineTheme]] as const) {
			for (const nerdFonts of ["0", "1"] as const) {
				vi.stubEnv("STATUSLINE_NERD_FONTS", nerdFonts);
				const busy = createHarness(`dedup-busy-${skinName}-${nerdFonts}`, "tui", {
					model: claude, theme, isIdle: false, hasPendingMessages: false, extensionStatuses: [],
				});
				const queued = createHarness(`dedup-queued-${skinName}-${nerdFonts}`, "tui", {
					model: claude, theme, isIdle: true, hasPendingMessages: true, extensionStatuses: [],
				});
				statuslineFooter(busy.pi);
				statuslineFooter(queued.pi);
				await busy.emit("session_start", { reason: "startup" });
				await queued.emit("session_start", { reason: "startup" });
				try {
					// Wide bar: center state pill renders, left ● and queued are suppressed.
					const wideBusy = strip(busy.getFooter()!.render(160)[0]!);
					expect(wideBusy, `${skinName}-${nerdFonts}`).toContain("working");
					expect(wideBusy, `${skinName}-${nerdFonts}`).not.toContain("●");

					const wideQueued = strip(queued.getFooter()!.render(160)[0]!);
					expect(wideQueued, `${skinName}-${nerdFonts}`).toContain("◔ queued");
					expect(wideQueued.match(/queued/g)).toHaveLength(1);

					// Narrow bar where center pill does not fit: left ● and queued appear, center pill omitted.
					const narrowBusy = strip(busy.getFooter()!.render(74)[0]!);
					expect(visibleWidth(narrowBusy)).toBeLessThanOrEqual(74);
					expect(narrowBusy, `${skinName}-${nerdFonts}`).toContain("●");
					expect(narrowBusy, `${skinName}-${nerdFonts}`).not.toContain("working");

					const narrowQueued = strip(queued.getFooter()!.render(74)[0]!);
					expect(visibleWidth(narrowQueued)).toBeLessThanOrEqual(74);
					expect(narrowQueued, `${skinName}-${nerdFonts}`).toContain("queued");
					expect(narrowQueued, `${skinName}-${nerdFonts}`).not.toContain("◔ queued");
				} finally {
					busy.disposeFooter();
					queued.disposeFooter();
				}
			}
		}
		vi.unstubAllEnvs();
	});

	it("formats desk latency compactly, gates diagnostic ttfb, and distinguishes ASCII elapsed vs TTFT icons", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const harness = createHarness("latency-refinements", "tui", { model: claude, extensionStatuses: [] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const runCall = async (ttfbMs: number, ttftMs: number, totalMs: number, output: number) => {
			await harness.emit("before_provider_headers", { headers: {} });
			now += ttfbMs;
			await harness.emit("after_provider_response", {});
			now += ttftMs - ttfbMs;
			await harness.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "hi" } });
			now += totalMs - ttftMs;
			await harness.emit("message_end", assistantEnd(output));
			now += 100;
		};
		try {
			// Single request: no parenthetical last values, non-diagnostic ttfb hidden.
			await runCall(100, 200, 2_000, 200);
			let telemetry = strip(harness.getFooter()!.render(200)[1]!);
			expect(telemetry).toContain("◷ 0m");
			expect(telemetry).toContain("⏱ 200ms");
			expect(telemetry).not.toContain("⏱ 0m");
			expect(telemetry).not.toContain("200ms (");
			expect(telemetry).not.toContain("⇄");

			// Second request (fast ttfb 150ms, ttft 400ms): shows avg (last), still hides ttfb.
			await runCall(150, 400, 4_000, 600);
			telemetry = strip(harness.getFooter()!.render(200)[1]!);
			expect(telemetry).toContain("⏱ 300ms (400ms)");
			expect(telemetry).toContain("» 133 tok/s (150)");
			expect(telemetry).not.toContain("↺");
			expect(telemetry).not.toContain("⇄");

			// Diagnostic TTFB >= 1000ms: shows ASCII ⇄ 1.2s and Nerd Font md-server-network 1.2s.
			await runCall(1_200, 1_400, 3_000, 300);
			telemetry = strip(harness.getFooter()!.render(200)[1]!);
			expect(telemetry).toContain("⇄ 1.2s");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "1");
			expect(strip(harness.getFooter()!.render(200)[1]!)).toContain("\u{F048D} 1.2s");
			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");

			// Diagnostic TTFB gap (TTFT - TTFB >= 2000ms) even when TTFB < 1000ms: shows ⇄ 200ms.
			await runCall(200, 2_500, 3_500, 350);
			telemetry = strip(harness.getFooter()!.render(200)[1]!);
			expect(telemetry).toContain("⇄ 200ms");
		} finally {
			harness.disposeFooter();
			vi.unstubAllEnvs();
		}
	});

	it("surfaces cacheWrite on warm and cold-write turns in desk telemetry", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const warmBranch = [
			{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() - 60_000 } },
			{
				id: "a1", type: "message",
				message: {
					role: "assistant",
					usage: { input: 46_000, output: 1_000, cacheRead: 120_000, cacheWrite: 18_000, cost: { total: 0.45 } },
					content: [],
				},
			},
		];
		const warm = createHarness("cache-write-warm", "tui", { model: claude, branch: warmBranch, extensionStatuses: [] });
		statuslineFooter(warm.pi);
		await warm.emit("session_start", { reason: "startup" });

		const coldBranch = [
			{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() - 60_000 } },
			{
				id: "a1", type: "message",
				message: {
					role: "assistant",
					usage: { input: 5_000, output: 500, cacheRead: 0, cacheWrite: 18_000, cost: { total: 0.12 } },
					content: [],
				},
			},
		];
		const cold = createHarness("cache-write-cold", "tui", { model: claude, branch: coldBranch, extensionStatuses: [] });
		statuslineFooter(cold.pi);
		await cold.emit("session_start", { reason: "startup" });
		try {
			const warmRow = strip(warm.getFooter()!.render(220)[1]!);
			expect(warmRow).toContain("⚡ 120k 65% +18k wr");

			const coldRow = strip(cold.getFooter()!.render(220)[1]!);
			expect(coldRow).toContain("⚡ +18k wr");
		} finally {
			warm.disposeFooter();
			cold.disposeFooter();
			vi.unstubAllEnvs();
		}
	});

	it("shows subagent cost breakdown beside combined total without double-counting cost", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const branch = [
			{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() - 120_000 } },
			{
				id: "a1", type: "message",
				message: {
					role: "assistant",
					usage: { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0.75 } },
					content: [],
				},
			},
			{
				id: "t1", type: "message",
				message: {
					role: "toolResult",
					toolName: "Agent",
					isError: false,
					usage: { input: 50_000, output: 8_000, cacheRead: 0, cacheWrite: 0, cost: { total: 1.20 } },
					content: [],
				},
			},
		];
		const harness = createHarness("subagent-cost", "tui", { model: claude, branch, extensionStatuses: [] });
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const telemetry = strip(harness.getFooter()!.render(220)[1]!);
			// Total is 0.75 + 1.20 = $1.95 (never double-counted as $3.15).
			expect(telemetry).toContain("$1.95  ($1.20 sub)");
			expect(telemetry).not.toContain("$3.15");
		} finally {
			harness.disposeFooter();
			vi.unstubAllEnvs();
		}
	});

	it("counts only edit and write tool calls in the workspace edited count", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const readOnlyBranch = [
			{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() } },
			{
				id: "a1", type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0, cost: { total: 0.01 } },
					content: [
						{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", name: "ffgrep", arguments: { path: "src/b.ts" } },
						{ type: "toolCall", name: "ls", arguments: { path: "src/" } },
					],
				},
			},
		];
		const readOnly = createHarness("readonly-session", "tui", { model: claude, branch: readOnlyBranch, extensionStatuses: [] });
		statuslineFooter(readOnly.pi);
		await readOnly.emit("session_start", { reason: "startup" });

		const editBranch = [
			...readOnlyBranch,
			{
				id: "a2", type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0, cost: { total: 0.01 } },
					content: [
						{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", name: "write", arguments: { path: "src/c.ts" } },
						{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } },
					],
				},
			},
		];
		const edited = createHarness("edited-mutated", "tui", { model: claude, branch: editBranch, extensionStatuses: [] });
		statuslineFooter(edited.pi);
		await edited.emit("session_start", { reason: "startup" });
		try {
			const readOnlyWorkspace = strip(readOnly.getFooter()!.render(200).at(-1)!);
			expect(readOnlyWorkspace).not.toContain("edited");
			expect(readOnlyWorkspace).not.toContain("touched");

			const editedWorkspace = strip(edited.getFooter()!.render(200).at(-1)!);
			expect(editedWorkspace).toContain("✎ 2 edited");
		} finally {
			readOnly.disposeFooter();
			edited.disposeFooter();
			vi.unstubAllEnvs();
		}
	});

	it("parses git porcelain details, renders staged/untracked/unstaged/conflicts, and detects linked worktrees", async () => {
		expect(parseGitPorcelain("")).toEqual({ status: "clean", staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
		expect(parseGitPorcelain("M  a.ts\nA  b.ts\n?? c.ts\n M d.ts\nMM e.ts\nUU f.ts\nAA g.ts\n")).toEqual({
			status: "dirty",
			staged: 3,
			unstaged: 2,
			untracked: 1,
			conflicts: 2,
		});

		const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "statusline-wt-"));
		try {
			const mainRepo = path.join(tmpRoot, "main-repo");
			mkdirSync(path.join(mainRepo, ".git"), { recursive: true });
			mkdirSync(path.join(mainRepo, "nested"), { recursive: true });
			expect(detectLinkedWorktree(mainRepo)).toBe(false);
			expect(detectLinkedWorktree(path.join(mainRepo, "nested"))).toBe(false);

			const linkedWt = path.join(tmpRoot, "linked-wt");
			mkdirSync(path.join(linkedWt, "sub", "dir"), { recursive: true });
			writeFileSync(path.join(linkedWt, ".git"), "gitdir: /repo/.git/worktrees/foo\n");
			expect(detectLinkedWorktree(linkedWt)).toBe(true);
			expect(detectLinkedWorktree(path.join(linkedWt, "sub", "dir"))).toBe(true);

			const submodule = path.join(tmpRoot, "submod");
			mkdirSync(submodule, { recursive: true });
			writeFileSync(path.join(submodule, ".git"), "gitdir: ../.git/modules/bar\n");
			expect(detectLinkedWorktree(submodule)).toBe(false);

			vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
			const mockGit = (porcelain: string, shortstat = "") => {
				vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
					const cb = callback as (error: Error | null, stdout: string) => void;
					if (args?.[1] === "status") cb(null, porcelain);
					else if (args?.[0] === "diff") cb(null, shortstat);
					else cb(new Error("no upstream"), "");
					return {} as ReturnType<typeof execFile>;
				});
			};

			// Worktree + conflicts + diff + staged + untracked.
			mockGit("UU conflict.ts\nM  staged.ts\n?? new.ts\n", "1 file changed, 5 insertions(+), 2 deletions(-)");
			const wtHarness = createHarness("git-porcelain-wt", "tui", { cwd: linkedWt, extensionStatuses: [] });
			statuslineFooter(wtHarness.pi);
			await wtHarness.emit("session_start", { reason: "startup" });
			const wtWorkspace = strip(wtHarness.getFooter()!.render(220).at(-1)!);
			expect(wtWorkspace).toContain("⎇ main wt");
			expect(wtWorkspace).toContain("✕ 1 conflict");
			expect(wtWorkspace).toContain("+5 −2");
			expect(wtWorkspace).toContain("●1");
			expect(wtWorkspace).toContain("?1");
			wtHarness.disposeFooter();

			// Plural conflicts.
			mockGit("UU a.ts\nDD b.ts\n");
			const pluralHarness = createHarness("git-porcelain-conflicts", "tui", { cwd: mainRepo, extensionStatuses: [] });
			statuslineFooter(pluralHarness.pi);
			await pluralHarness.emit("session_start", { reason: "startup" });
			const pluralWorkspace = strip(pluralHarness.getFooter()!.render(220).at(-1)!);
			expect(pluralWorkspace).not.toContain("main wt");
			expect(pluralWorkspace).toContain("✕ 2 conflicts");
			pluralHarness.disposeFooter();

			// Unstaged-only fallback with empty shortstat renders ~N.
			mockGit(" M mode-only.sh\n M another.sh\n", "");
			const unstagedHarness = createHarness("git-porcelain-unstaged", "tui", { cwd: mainRepo, extensionStatuses: [] });
			statuslineFooter(unstagedHarness.pi);
			await unstagedHarness.emit("session_start", { reason: "startup" });
			expect(strip(unstagedHarness.getFooter()!.render(220).at(-1)!)).toContain("~2");
			unstagedHarness.disposeFooter();
		} finally {
			vi.unstubAllEnvs();
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("prefixes SSH remote host on workspace paths and preserves it when shortening", () => {
		expect(formatWorkspacePath("/Users/ada/code/pi", "/Users/ada", {}, "guava.local")).toBe("~/code/pi");
		expect(formatWorkspacePath("/Users/ada/code/pi", "/Users/ada", { SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22" }, "guava.local")).toBe("guava:~/code/pi");
		expect(formatWorkspacePath("/Users/ada", "/Users/ada", { SSH_TTY: "/dev/pts/0" }, "box1")).toBe("box1:~");
		expect(formatWorkspacePath("/tmp/work", "/Users/ada", { SSH_CLIENT: "10.0.0.1 1234 22" }, "node-7.internal")).toBe("node-7:/tmp/work");

		expect(shortenPath("guava:~/a/b/c/project", 18)).toBe("guava:~/…/project");
		expect(shortenPath("guava:~/a/b/c/project", 25)).toBe("guava:~/a/b/c/project");
		expect(shortenPath("C:/Users/ada/very/deep/project", 18)).toBe("C:/…/deep/project");
		for (const max of [1, 4, 8, 12, 18]) {
			expect(visibleWidth(shortenPath("guava:~/deep/nested/project", max)), `${max}`).toBeLessThanOrEqual(max);
		}
	});

	it("shows short session ID on Desk Row 3 and drops it before edited, cwd, and git", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const branch = [
			{ id: "u1", type: "message", message: { role: "user", timestamp: Date.now() } },
			{
				id: "a1", type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0, cost: { total: 0.01 } },
					content: [{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } }],
				},
			},
		];
		const harness = createHarness("12345678-abcd-ef00-9999", "tui", {
			model: claude,
			branch,
			extensionStatuses: [],
			cwd: "/tmp/project",
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			const wide = strip(harness.getFooter()!.render(200).at(-1)!);
			expect(wide).toContain("#12345678");
			expect(wide.indexOf("/tmp/project")).toBeLessThan(wide.indexOf("#12345678"));
		} finally {
			harness.disposeFooter();
			vi.unstubAllEnvs();
		}

		// Force Row 3 overflow with a long git branch name: #shortId (rank 0) drops before edited, cwd, and git.
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const crowdedHarness = createHarness("abcdef12-3456-7890", "tui", {
			model: claude,
			branch,
			gitBranch: `feature/${"very-long-branch-name-".repeat(5)}end`,
			extensionStatuses: [],
			cwd: "/tmp/my-project",
		});
		statuslineFooter(crowdedHarness.pi);
		await crowdedHarness.emit("session_start", { reason: "startup" });
		try {
			const row3 = strip(crowdedHarness.getFooter()!.render(175).at(-1)!);
			expect(visibleWidth(row3)).toBeLessThanOrEqual(175);
			expect(row3).not.toContain("#abcdef12");
			expect(row3).toContain("1 edited");
			expect(row3).toContain("my-project");
		} finally {
			crowdedHarness.disposeFooter();
			vi.unstubAllEnvs();
		}
	});

	it("keeps Desk stably at 3 rows for routine activity/relay and promotes attention, problem, or >2 items to row 4", async () => {
		vi.stubEnv("STATUSLINE_NERD_FONTS", "0");
		const harness = createHarness("desk-3row-stability", "tui", {
			model: claude,
			extensionStatuses: [],
			cwd: "/tmp/project",
		});
		statuslineFooter(harness.pi);
		await harness.emit("session_start", { reason: "startup" });
		try {
			// Baseline: 3 rows.
			expect(harness.getFooter()!.render(200)).toHaveLength(3);

			// 1 routine status + 1 routine collaboration (total 2 <= 2): folds into Row 3 (still 3 rows!).
			harness.setStatus("subagents", "subagents: 2 running");
			harness.setStatus("relay-rooms", "#dev");
			const folded = harness.getFooter()!.render(200).map(strip);
			expect(folded).toHaveLength(3);
			expect(folded[2]).toContain("subagents: 2 running");
			expect(folded[2]).toContain("⇌ #dev");
			expect(folded[2]).toContain("/tmp/project");

			// >2 items promotes to the dedicated 4th Activity row.
			harness.setStatus("goal", "goal: finish refactor");
			const overflow = harness.getFooter()!.render(200).map(strip);
			expect(overflow).toHaveLength(4);
			expect(overflow[1]).toContain("goal: finish refactor");
			expect(overflow[1]).toContain("subagents: 2 running");
			expect(overflow[1]).toContain("⇌ #dev");

			// Back to 1 status, but with attention/problem keywords: promotes to 4 rows.
			harness.setStatus("subagents", undefined);
			harness.setStatus("relay-rooms", undefined);
			for (const status of ["goal: build blocked", "goal: check failed", "goal: waiting paused"]) {
				harness.setStatus("goal", status);
				const promoted = harness.getFooter()!.render(200).map(strip);
				expect(promoted, status).toHaveLength(4);
				expect(promoted[1], status).toContain(status);
			}

			// Clearing back to routine returns stably to 3 rows.
			harness.setStatus("goal", "goal: steady progress");
			const calm = harness.getFooter()!.render(200).map(strip);
			expect(calm).toHaveLength(3);
			expect(calm[2]).toContain("goal: steady progress");
		} finally {
			harness.disposeFooter();
			vi.unstubAllEnvs();
		}
	});
});
