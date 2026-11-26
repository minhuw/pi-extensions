import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { CacheLensTracker, type CacheCallRecord } from "../cache-lens.ts";
import {
	CacheOverlay,
	cacheOverlayOptions,
	openCacheOverlay,
	renderHitSparkline,
	type CacheOverlaySource,
	type CacheWarmthSnapshot,
} from "../cache-overlay.ts";

const stripAnsi = (text: string): string => stripVTControlCharacters(text.replace(/\x1b\[[0-9;:]*m/g, ""));

const TOKEN_ANSI: Record<string, string> = {
	success: "\x1b[32m",
	warning: "\x1b[33m",
	error: "\x1b[31m",
	dim: "\x1b[90m",
	muted: "\x1b[37m",
	accent: "\x1b[36m",
	border: "\x1b[90m",
};

const plainTheme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const ansiTheme = {
	fg: (token: string, text: string) => `${TOKEN_ANSI[token] ?? "\x1b[39m"}${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

/** Tagged theme that wraps text with `<token>...</token>` for unambiguous token assertions. */
const taggedTheme = {
	fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	bold: (text: string) => `<b>${text}</b>`,
} as unknown as Theme;

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	esc: "\x1b",
	tab: "\t",
	ctrlC: "\x03",
} as const;

function makeRecord(overrides: Partial<CacheCallRecord> = {}): CacheCallRecord {
	return {
		callIndex: 1,
		atMs: 1_700_000_000_000,
		model: "anthropic/claude-sonnet-4",
		api: "anthropic-messages",
		inputTokens: 1_000,
		outputTokens: 200,
		cacheRead: 9_000,
		cacheWrite: 0,
		totalPromptTokens: 10_000,
		hitPct: 90,
		cause: "healthy",
		tag: null,
		isAnomaly: false,
		detail: null,
		systemHash: "aaa111bbb222",
		toolsHash: "ccc333ddd444",
		itemCount: 4,
		...overrides,
	};
}

function makeSource(opts: {
	records?: CacheCallRecord[];
	warmth?: CacheWarmthSnapshot | null;
	omitWarmthMethod?: boolean;
} = {}): CacheOverlaySource & { resetSpy: ReturnType<typeof vi.fn>; reportSpy: ReturnType<typeof vi.fn> } {
	let records = [...(opts.records ?? [])];
	const resetSpy = vi.fn(() => {
		records = [];
	});
	const reportSpy = vi.fn((mode: "summary" | "anomalies") => `report:${mode}:${records.length}`);

	const source: CacheOverlaySource & { resetSpy: ReturnType<typeof vi.fn>; reportSpy: ReturnType<typeof vi.fn> } = {
		sessionStats() {
			const evaluable = records.filter((r) => r.cause !== "usage_unavailable");
			const promptTotal = evaluable.reduce((sum, r) => sum + r.totalPromptTokens, 0);
			const cacheRead = evaluable.reduce((sum, r) => sum + r.cacheRead, 0);
			const cacheWrite = evaluable.reduce((sum, r) => sum + r.cacheWrite, 0);
			const anomalyCount = records.filter((r) => r.isAnomaly).length;
			return {
				calls: evaluable.length,
				promptTotal,
				cacheRead,
				cacheWrite,
				hitPct: promptTotal > 0 ? Math.round((cacheRead / promptTotal) * 100) : null,
				anomalyCount,
			};
		},
		getRecords: () => records,
		getAnomalies: () => records.filter((r) => r.isAnomaly),
		lastRecord: () => records.at(-1) ?? null,
		formatCacheReport: reportSpy,
		reset: resetSpy,
		resetSpy,
		reportSpy,
	};

	if (!opts.omitWarmthMethod) {
		source.cacheWarmth = () => opts.warmth ?? null;
	}

	return source;
}

describe("renderHitSparkline", () => {
	it("returns an empty string when records are empty or maxPoints <= 0", () => {
		expect(renderHitSparkline([], ansiTheme)).toBe("");
		expect(renderHitSparkline([makeRecord()], ansiTheme, 0)).toBe("");
		expect(renderHitSparkline([makeRecord()], ansiTheme, -5)).toBe("");
	});

	it("renders dim middle dots for null hitPct, cold_start, and below_min_tokens", () => {
		const records = [
			makeRecord({ callIndex: 1, hitPct: null, cause: "usage_unavailable" }),
			makeRecord({ callIndex: 2, hitPct: 0, cause: "cold_start" }),
			makeRecord({ callIndex: 3, hitPct: 95, cause: "below_min_tokens" }),
		];
		expect(renderHitSparkline(records, taggedTheme)).toBe(
			"<dim>·</dim><dim>·</dim><dim>·</dim>",
		);
		expect(stripAnsi(renderHitSparkline(records, ansiTheme))).toBe("···");
	});

	it("maps 0%, 50%, 100% and threshold boundaries to the right bar levels and ANSI colors", () => {
		const records = [
			makeRecord({ hitPct: 0, cause: "partial_hit" }),
			makeRecord({ hitPct: 34, cause: "partial_hit" }),
			makeRecord({ hitPct: 35, cause: "partial_hit" }),
			makeRecord({ hitPct: 50, cause: "warmup" }),
			makeRecord({ hitPct: 69, cause: "warmup" }),
			makeRecord({ hitPct: 70, cause: "healthy" }),
			makeRecord({ hitPct: 100, cause: "healthy" }),
		];

		expect(renderHitSparkline(records, taggedTheme)).toBe(
			"<error>▁</error>" +
			"<error>▃</error>" +
			"<warning>▃</warning>" +
			"<warning>▅</warning>" +
			"<warning>▆</warning>" +
			"<success>▆</success>" +
			"<success>█</success>",
		);

		const ansi = renderHitSparkline(records, ansiTheme);
		expect(ansi).toContain("\x1b[31m▁\x1b[0m"); // error
		expect(ansi).toContain("\x1b[33m▅\x1b[0m"); // warning
		expect(ansi).toContain("\x1b[32m█\x1b[0m"); // success
		expect(stripAnsi(ansi)).toBe("▁▃▃▅▆▆█");
	});

	it("truncates to the most recent maxPoints records (default 30)", () => {
		const records = Array.from({ length: 40 }, (_, i) =>
			makeRecord({
				callIndex: i + 1,
				hitPct: i < 10 ? 0 : 100,
				cause: i < 10 ? "partial_hit" : "healthy",
			}),
		);

		// Default maxPoints = 30 -> only the last 30 records (all 100%)
		const defaultSpark = stripAnsi(renderHitSparkline(records, ansiTheme));
		expect([...defaultSpark]).toHaveLength(30);
		expect(defaultSpark).toBe("█".repeat(30));

		// Explicit maxPoints = 5 -> last 5 records
		const customRecords = [
			makeRecord({ hitPct: 0, cause: "partial_hit" }),
			makeRecord({ hitPct: 0, cause: "partial_hit" }),
			makeRecord({ hitPct: 50, cause: "warmup" }),
			makeRecord({ hitPct: 100, cause: "healthy" }),
			makeRecord({ hitPct: 100, cause: "healthy" }),
		];
		expect(stripAnsi(renderHitSparkline(customRecords, ansiTheme, 3))).toBe("▅██");
	});
});

describe("CacheOverlay", () => {
	it("renders empty state cleanly without sparkline row", () => {
		const tui = { mode: "regular" as const, terminal: { rows: 24 }, requestRender: vi.fn() };
		const source = makeSource({ records: [], omitWarmthMethod: true });
		const overlay = new CacheOverlay({
			tui,
			theme: plainTheme,
			source,
			onClose: vi.fn(),
		});

		const text = overlay.render(90).join("\n");
		expect(text).toContain("Prefix KV Cache");
		expect(text).toContain("All (0)");
		expect(text).toContain("n/a hit");
		expect(text).toContain("0 calls");
		expect(text).toContain("0 anomalies");
		expect(text).not.toContain("Trend");
		expect(text).toContain("No cache calls recorded yet.");
		expect(text).toContain("a toggle all/anomalies");
		expect(text).toContain("q/esc close");

		// Switch to anomalies view via `a`
		overlay.handleInput("a");
		const anomalyText = overlay.render(90).join("\n");
		expect(anomalyText).toContain("Anomalies (0)");
		expect(anomalyText).toContain("No cache anomalies recorded.");
	});

	it("renders summary, sparkline, newest-first records, and indented details", () => {
		const records = [
			makeRecord({
				callIndex: 1,
				model: "anthropic/claude-sonnet-4",
				cacheRead: 0,
				cacheWrite: 12_000,
				totalPromptTokens: 12_000,
				hitPct: 0,
				cause: "cold_start",
				tag: "(cold)",
				isAnomaly: false,
				detail: "wrote 12k",
			}),
			makeRecord({
				callIndex: 2,
				model: "anthropic/claude-sonnet-4",
				cacheRead: 10_800,
				cacheWrite: 0,
				totalPromptTokens: 12_000,
				hitPct: 90,
				cause: "healthy",
				tag: null,
				isAnomaly: false,
				detail: null,
			}),
			makeRecord({
				callIndex: 3,
				model: "openai/gpt-5",
				cacheRead: 1_200,
				cacheWrite: 4_000,
				totalPromptTokens: 12_000,
				hitPct: 10,
				cause: "tools_mutated",
				tag: "!tools",
				isAnomaly: true,
				detail: "+bash, ~read (aaa111->bbb222)",
			}),
		];

		const tui = { mode: "regular" as const, terminal: { rows: 30 }, requestRender: vi.fn() };
		const source = makeSource({
			records,
			warmth: { active: true, ttlSec: 290, remainingMs: 192_000, expiresAtMs: 1_700_000_192_000 },
		});
		const overlay = new CacheOverlay({
			tui,
			theme: plainTheme,
			source,
			onClose: vi.fn(),
		});

		const lines = overlay.render(100);
		const joined = lines.join("\n");

		expect(joined).toContain("Prefix KV Cache");
		expect(joined).toContain("All (3)");
		expect(joined).toContain("33% hit");
		expect(joined).toContain("12k/36k read");
		expect(joined).toContain("16k write");
		expect(joined).toContain("3 calls");
		expect(joined).toContain("1 anomaly");
		expect(joined).toContain("warm 3m12s");
		expect(joined).toContain("Trend  ·▇▂");

		// Newest first (#3 appears before #2 which appears before #1)
		const idx3 = lines.findIndex((l) => l.includes("#3"));
		const idx2 = lines.findIndex((l) => l.includes("#2"));
		const idx1 = lines.findIndex((l) => l.includes("#1"));
		expect(idx3).toBeGreaterThan(-1);
		expect(idx2).toBeGreaterThan(idx3);
		expect(idx1).toBeGreaterThan(idx2);

		// Model shortened, tag and indented detail rendered (no double-parens on "(cold)")
		expect(lines[idx3]).toContain("gpt-5");
		expect(lines[idx3]).toContain("10%");
		expect(lines[idx3]).toContain("1.2k/12k");
		expect(lines[idx3]).toContain("tools_mutated");
		expect(lines[idx3]).toContain("(!tools)");
		expect(lines[idx3 + 1]).toContain("    +bash, ~read (aaa111->bbb222)");
		expect(lines[idx1]).toContain("cold_start (cold)");
		expect(lines[idx1]).not.toContain("((cold))");
	});

	it("colors warmth as success (>= 60s), warning (< 60s), and dim (cold)", () => {
		const tui = { mode: "regular" as const, terminal: { rows: 24 }, requestRender: vi.fn() };
		const records = [makeRecord()];

		const warmSuccess = new CacheOverlay({
			tui,
			theme: ansiTheme,
			source: makeSource({
				records,
				warmth: { active: true, ttlSec: 290, remainingMs: 192_000, expiresAtMs: 0 },
			}),
			onClose: vi.fn(),
		});
		expect(warmSuccess.render(100).join("\n")).toContain("\x1b[32mwarm 3m12s\x1b[0m");

		const warmWarning = new CacheOverlay({
			tui,
			theme: ansiTheme,
			source: makeSource({
				records,
				warmth: { active: true, ttlSec: 290, remainingMs: 45_000, expiresAtMs: 0 },
			}),
			onClose: vi.fn(),
		});
		expect(warmWarning.render(100).join("\n")).toContain("\x1b[33mwarm 45s\x1b[0m");

		const warmCold = new CacheOverlay({
			tui,
			theme: ansiTheme,
			source: makeSource({
				records,
				warmth: { active: false, ttlSec: 290, remainingMs: 0, expiresAtMs: 0 },
			}),
			onClose: vi.fn(),
		});
		expect(warmCold.render(100).join("\n")).toContain("\x1b[90mcold\x1b[0m");
	});

	it("toggles between all and anomalies via 'a' and Tab, resetting scroll to top", () => {
		const records = Array.from({ length: 15 }, (_, i) =>
			makeRecord({
				callIndex: i + 1,
				hitPct: i === 12 ? 15 : 88,
				cause: i === 12 ? "system_mutated" : "healthy",
				tag: i === 12 ? "!sys" : null,
				isAnomaly: i === 12,
				detail: i === 12 ? "char@12 byte@12" : null,
			}),
		);
		const tui = { mode: "regular" as const, terminal: { rows: 14 }, requestRender: vi.fn() };
		const overlay = new CacheOverlay({
			tui,
			theme: plainTheme,
			source: makeSource({ records }),
			onClose: vi.fn(),
		});

		overlay.render(90);
		overlay.handleInput("j");
		overlay.handleInput("j");
		expect(overlay.render(90).join("\n")).not.toContain("#15");

		// Press `a` -> anomalies view, scroll reset
		overlay.handleInput("a");
		const anomaliesView = overlay.render(90).join("\n");
		expect(anomaliesView).toContain("Anomalies (1)");
		expect(anomaliesView).toContain("#13");
		expect(anomaliesView).toContain("system_mutated");
		expect(anomaliesView).not.toContain("#15");

		// Press Tab -> back to all view, scroll reset to top (#15 visible again)
		overlay.handleInput(KEYS.tab);
		const allView = overlay.render(90).join("\n");
		expect(allView).toContain("All (15)");
		expect(allView).toContain("#15");
	});

	it("scrolls cleanly with j/k, arrows, pageUp/pageDown, g/G, home/end and clamps bounds", () => {
		const records = Array.from({ length: 20 }, (_, i) =>
			makeRecord({ callIndex: i + 1, hitPct: 85, cause: "healthy" }),
		);
		const tui = { mode: "regular" as const, terminal: { rows: 16 }, requestRender: vi.fn() };
		const overlay = new CacheOverlay({
			tui,
			theme: plainTheme,
			source: makeSource({ records }),
			onClose: vi.fn(),
		});

		// Initial render shows newest (#20) at top
		let out = overlay.render(80).join("\n");
		expect(out).toContain("#20");
		expect(out).not.toContain("#1 ");

		// Scroll up at top stays clamped at top
		overlay.handleInput("k");
		overlay.handleInput(KEYS.up);
		expect(overlay.render(80).join("\n")).toContain("#20");

		// Scroll down with j and down arrow
		overlay.handleInput("j");
		overlay.handleInput(KEYS.down);
		out = overlay.render(80).join("\n");
		expect(out).not.toContain("#20");
		expect(out).toContain("#18");

		// Jump to bottom with G
		overlay.handleInput("G");
		out = overlay.render(80).join("\n");
		expect(out).toContain("#1 ");
		expect(out).not.toContain("#20");

		// Additional pageDown at bottom stays clamped
		overlay.handleInput(KEYS.pageDown);
		expect(overlay.render(80).join("\n")).toContain("#1 ");

		// PageUp moves up
		overlay.handleInput(KEYS.pageUp);
		expect(overlay.render(80).join("\n")).not.toContain("#1 ");

		// Jump to top with g, then bottom with End, then top with Home
		overlay.handleInput("g");
		expect(overlay.render(80).join("\n")).toContain("#20");

		overlay.handleInput(KEYS.end);
		expect(overlay.render(80).join("\n")).toContain("#1 ");

		overlay.handleInput(KEYS.home);
		expect(overlay.render(80).join("\n")).toContain("#20");
	});

	it("handles reset ('r'), fullscreen ('f'), and close ('q', Esc, Ctrl+C)", () => {
		const tui = { mode: "regular" as const, terminal: { rows: 24 }, requestRender: vi.fn() };
		const source = makeSource({ records: [makeRecord({ callIndex: 1 })] });
		const onClose = vi.fn();
		const onReset = vi.fn(() => source.reset());
		const onToggleFullscreen = vi.fn();

		const overlay = new CacheOverlay({
			tui,
			theme: plainTheme,
			source,
			onClose,
			onReset,
			onToggleFullscreen,
		});

		overlay.render(80);
		overlay.handleInput("f");
		expect(onToggleFullscreen).toHaveBeenCalledWith(true);
		overlay.handleInput("f");
		expect(onToggleFullscreen).toHaveBeenCalledWith(false);

		overlay.handleInput("r");
		expect(onReset).toHaveBeenCalledTimes(1);
		expect(overlay.render(80).join("\n")).toContain("No cache calls recorded yet.");

		overlay.handleInput("q");
		overlay.handleInput(KEYS.esc);
		overlay.handleInput(KEYS.ctrlC);
		expect(onClose).toHaveBeenCalledTimes(3);
	});

	it("enforces visibleWidth(line) <= width across narrow and wide viewports", () => {
		const records = [
			makeRecord({
				callIndex: 1,
				model: "provider/very-long-model-identifier-with-extra-suffix-2026-11-26",
				hitPct: 12,
				cause: "tools_mutated",
				tag: "!tools",
				isAnomaly: true,
				detail: "added +very_long_tool_name_one, +very_long_tool_name_two, ~modified_tool_schema (abcdef012345->9876543210fe)",
			}),
			makeRecord({
				callIndex: 2,
				model: "anthropic/claude-opus-4-5",
				hitPct: 94,
				cause: "healthy",
				detail: "short detail",
			}),
		];
		const source = makeSource({
			records,
			warmth: { active: true, ttlSec: 290, remainingMs: 125_000, expiresAtMs: 0 },
		});

		for (const fullscreen of [false, true]) {
			const tui = { mode: fullscreen ? ("fullscreen" as const) : ("regular" as const), terminal: { rows: 22 }, requestRender: vi.fn() };
			const overlay = new CacheOverlay({
				tui,
				theme: ansiTheme,
				source,
				fullscreen,
				onClose: vi.fn(),
			});

			for (const width of [1, 4, 10, 24, 40, 80, 140]) {
				const lines = overlay.render(width);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("accepts a real CacheLensTracker instance as CacheOverlaySource", () => {
		const tracker = new CacheLensTracker();
		tracker.recordRequest(
			{ model: "claude-sonnet-4", system: "Be helpful.", messages: [{ role: "user", content: "hi" }] },
			{ api: "anthropic-messages", modelKey: "anthropic/claude-sonnet-4", nowMs: 1_000 },
		);
		tracker.recordMessageEnd(
			{
				role: "assistant",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 2_000 },
			},
			1_500,
		);

		const tui = { mode: "regular" as const, terminal: { rows: 24 }, requestRender: vi.fn() };
		const overlay = new CacheOverlay({
			tui,
			theme: plainTheme,
			source: tracker,
			onClose: vi.fn(),
			now: () => 2_000,
		});

		const text = overlay.render(100).join("\n");
		expect(text).toContain("Prefix KV Cache");
		expect(text).toContain("All (1)");
		expect(text).toContain("cold_start");
	});
});

describe("openCacheOverlay", () => {
	it("opens CacheOverlay via ctx.ui.custom with overlay options and supports fullscreen toggle + reset", async () => {
		let component: CacheOverlay | undefined;
		let passedOptions: { overlay?: boolean; overlayOptions?: () => unknown } | undefined;
		const tui = { mode: "regular" as const, terminal: { rows: 24 }, requestRender: vi.fn() };
		const source = makeSource({ records: [makeRecord({ callIndex: 1 })] });
		const onReset = vi.fn();

		const ctx = {
			hasUI: true,
			ui: {
				custom: vi.fn(
					(
						factory: (tuiArg: unknown, theme: Theme, kb: unknown, done: (val: undefined) => void) => CacheOverlay,
						opts: typeof passedOptions,
					) =>
						new Promise<undefined>((resolve) => {
							passedOptions = opts;
							component = factory(tui, plainTheme, undefined, resolve);
						}),
				),
				notify: vi.fn(),
			},
		} as unknown as ExtensionContext;

		const pending = openCacheOverlay(ctx, source, { initialView: "all", onReset });

		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(passedOptions?.overlay).toBe(true);
		expect(passedOptions?.overlayOptions?.()).toEqual(cacheOverlayOptions(false));

		// Toggle fullscreen via `f` updates overlayOptions dynamically
		component!.handleInput("f");
		expect(passedOptions?.overlayOptions?.()).toEqual(cacheOverlayOptions(true));

		// Press `r` resets source and calls onReset callback
		component!.handleInput("r");
		expect(source.resetSpy).toHaveBeenCalledTimes(1);
		expect(onReset).toHaveBeenCalledTimes(1);

		// Close via `q` resolves promise
		component!.handleInput("q");
		await expect(pending).resolves.toBeUndefined();
	});

	it("falls back to ctx.ui.notify when ctx.ui.custom is undefined", async () => {
		const notify = vi.fn();
		const source = makeSource({ records: [makeRecord()] });
		const ctx = {
			ui: { notify },
		} as unknown as ExtensionContext;

		await openCacheOverlay(ctx, source);
		expect(source.reportSpy).toHaveBeenCalledWith("summary");
		expect(notify).toHaveBeenCalledWith("report:summary:1", "info");

		await openCacheOverlay(ctx, source, { initialView: "anomalies" });
		expect(source.reportSpy).toHaveBeenCalledWith("anomalies");
		expect(notify).toHaveBeenCalledWith("report:anomalies:1", "info");
	});

	it("falls back to ctx.ui.notify when ctx.hasUI is false even if custom exists", async () => {
		const notify = vi.fn();
		const custom = vi.fn();
		const source = makeSource({ records: [makeRecord()] });
		const ctx = {
			hasUI: false,
			ui: { custom, notify },
		} as unknown as ExtensionContext;

		await openCacheOverlay(ctx, source, { initialView: "anomalies" });
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("report:anomalies:1", "info");
	});
});
