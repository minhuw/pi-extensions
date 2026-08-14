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
	model?: { id: string; provider?: string; reasoning?: boolean } | null;
	thinkingLevel?: string;
	contextUsage?: { percent?: number; tokens?: number; contextWindow: number } | null;
	branch?: any[];
	cwd?: string;
	gitBranch?: string | null;
	extensionStatuses?: string[];
	isIdle?: boolean;
	hasPendingMessages?: boolean;
};

function createHarness(sessionId: string, mode: "tui" | "print", options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const notifications: string[] = [];
	const requestRender = vi.fn();
	let footer: FooterComponent | undefined;
	let footerInstallCount = 0;
	let footerDisposeCount = 0;
	const branchSubscribe = vi.fn();
	const branchUnsubscribe = vi.fn();

	const tui = { requestRender };
	const footerData = {
		onBranchChange: vi.fn(() => {
			branchSubscribe();
			return () => branchUnsubscribe();
		}),
		getGitBranch: () => options.gitBranch ?? "main",
		getExtensionStatuses: () => new Map((options.extensionStatuses ?? ["READY"]).map((status) => [status, status])),
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
			getEntries: () => {
				throw new Error("collectStats must use getBranch()");
			},
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
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		notifications,
		requestRender,
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
				if (args?.[0] === "status") cb(statusError ? new Error("git unavailable") : null, statusOutput);
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
					usage: { input: 1, output: 2, cacheRead: 3, reasoning: 4, cost: { total: 0.01 } },
				},
			},
			{ type: "compaction", usage: { input: 10, output: 20, cacheRead: 30, reasoning: 40, cost: { total: 0.10 } } },
			{ type: "branch_summary", usage: { input: 100, output: 200, cacheRead: 300, reasoning: 400, cost: { total: 1 } } },
			{ type: "message", message: { role: "toolResult", usage: { input: 1, output: 2, cacheRead: 3, reasoning: 4, cost: { total: 0.01 } } } },
		];
		const harness = createHarness("usage-branch-boundary", "tui", {
			branch: activeBranch,
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
		expect(totals).not.toContain("1M");
		harness.getFooter()?.dispose?.();
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

describe("statusline footer degraded stream lifecycle", () => {
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

	it("preserves streaming metrics across reload", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const beforeReload = createHarness("reload-session", "tui");
		statuslineFooter(beforeReload.pi);
		await beforeReload.emit("session_start", { type: "session_start", reason: "startup" });

		now = 5_000;
		await beforeReload.emit("before_provider_headers", { type: "before_provider_headers", headers: {} });
		now = 5_250;
		await beforeReload.emit("message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		now = 6_250;
		await beforeReload.emit("message_end", assistantEnd(20));
		beforeReload.getFooter()?.dispose?.();
		await beforeReload.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

		const afterReload = createHarness("reload-session", "tui");
		statuslineFooter(afterReload.pi);
		await afterReload.emit("session_start", { type: "session_start", reason: "reload" });
		await afterReload.runCommand("footer", "debug");

		const debug = afterReload.notifications.at(-1);
		expect(debug).toContain("requests=1");
		expect(debug).toContain("avgTtft=250");
		expect(debug).toContain("lastTok/s=20.0");

		afterReload.getFooter()?.dispose?.();
		await afterReload.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
