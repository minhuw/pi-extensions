/**
 * High-density TUI overlay for `/cache` inspecting session Prefix KV Cache
 * hit rates, live TTL warmth, sparkline trend, and miss root-cause forensics.
 */

import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	matchesKey,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CacheCallRecord } from "./cache-lens.ts";

export interface CacheWarmthSnapshot {
	active: boolean;
	ttlSec: number;
	remainingMs: number;
	expiresAtMs: number;
}

export interface CacheSessionStats {
	calls: number;
	promptTotal: number;
	cacheRead: number;
	cacheWrite: number;
	hitPct: number | null;
	anomalyCount: number;
}

/**
 * Structural subset of `CacheLensTracker` consumed by the `/cache` overlay.
 * Optional `cacheWarmth` keeps the overlay decoupled from warmth-tracking
 * additions while seamlessly rendering live TTL countdowns when available.
 */
export interface CacheOverlaySource {
	sessionStats(): CacheSessionStats;
	getRecords(): readonly CacheCallRecord[];
	getAnomalies(): readonly CacheCallRecord[];
	lastRecord(): CacheCallRecord | null;
	formatCacheReport(mode: "summary" | "anomalies"): string;
	reset(): void;
	cacheWarmth?(nowMs?: number): CacheWarmthSnapshot | null;
}

export type CacheOverlayView = "all" | "anomalies";

export type CacheOverlayTui = Pick<TUI, "requestRender"> & {
	mode?: TUI["mode"];
	terminal?: { rows?: number };
};

export interface CacheOverlayOptions {
	tui: CacheOverlayTui;
	theme: Theme;
	source: CacheOverlaySource;
	keybindings?: Pick<KeybindingsManager, "matches">;
	initialView?: CacheOverlayView;
	fullscreen?: boolean;
	onClose: () => void;
	onReset?: () => void;
	onToggleFullscreen?: (fullscreen: boolean) => void;
	now?: () => number;
}

export interface OpenCacheOverlayOptions {
	initialView?: CacheOverlayView;
	onReset?: () => void;
}

const SPARK_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const DEFAULT_SPARKLINE_POINTS = 30;
const WARMTH_WARNING_MS = 60_000;
const MAX_MODEL_COL_WIDTH = 20;
const DETAIL_INDENT = "    ";

function sanitizeInline(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\t/g, "  ")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

function fmtCompactTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function shortModelName(model: string | null): string {
	if (!model) return "-";
	const clean = sanitizeInline(model);
	if (!clean) return "-";
	const slash = clean.lastIndexOf("/");
	return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function formatWarmthDuration(remainingMs: number): string {
	const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) {
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
}

function formatTag(tag: string | null): string {
	if (!tag) return "";
	const clean = sanitizeInline(tag);
	if (!clean) return "";
	return clean.startsWith("(") && clean.endsWith(")") ? clean : `(${clean})`;
}

function hitColorToken(hitPct: number): "success" | "warning" | "error" {
	if (hitPct >= 70) return "success";
	if (hitPct >= 35) return "warning";
	return "error";
}

/**
 * Renders an 8-level vertical bar sparkline for recent call hit rates.
 * Cold starts, below-min-token calls, and calls without `hitPct` render as dim `·`.
 */
export function renderHitSparkline(
	records: readonly CacheCallRecord[],
	theme: Theme,
	maxPoints = DEFAULT_SPARKLINE_POINTS,
): string {
	const limit = Math.floor(maxPoints);
	if (records.length === 0 || limit <= 0) return "";
	const slice = records.slice(-limit);
	let out = "";
	for (const rec of slice) {
		if (rec.hitPct == null || rec.cause === "cold_start" || rec.cause === "below_min_tokens") {
			out += theme.fg("dim", "·");
			continue;
		}
		const pct = Math.max(0, Math.min(100, rec.hitPct));
		const level = Math.round((pct / 100) * (SPARK_BARS.length - 1));
		out += theme.fg(hitColorToken(pct), SPARK_BARS[level]!);
	}
	return out;
}

export class CacheOverlay implements Component {
	private readonly tui: CacheOverlayTui;
	private readonly theme: Theme;
	private readonly source: CacheOverlaySource;
	private readonly keys: Pick<KeybindingsManager, "matches"> | undefined;
	private readonly onClose: () => void;
	private readonly onReset: (() => void) | undefined;
	private readonly onToggleFullscreen: ((fullscreen: boolean) => void) | undefined;
	private readonly now: () => number;

	private view: CacheOverlayView;
	private fullscreen: boolean;
	private scroll = 0;
	private maxScroll = 0;
	private pageSize = 10;

	constructor(options: CacheOverlayOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.source = options.source;
		this.keys = options.keybindings;
		this.view = options.initialView ?? "all";
		this.fullscreen = options.fullscreen ?? options.tui.mode === "fullscreen";
		this.onClose = options.onClose;
		this.onReset = options.onReset;
		this.onToggleFullscreen = options.onToggleFullscreen;
		this.now = options.now ?? (() => Date.now());
	}

	invalidate(): void {}

	private viewportHeight(headerLines: number): number {
		const rows = Math.max(0, this.tui.terminal?.rows ?? 24);
		const target = this.fullscreen ? rows : Math.floor(rows * 0.75);
		// Frame chrome: top border (1) + headerLines + separator (1) + separator (1) + footer (1) + bottom border (1)
		return Math.max(3, target - (headerLines + 5));
	}

	handleInput(data: string): void {
		const is = (
			id: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown" | "tui.select.cancel",
			fallback: "up" | "down" | "pageUp" | "pageDown" | "escape",
		) => (this.keys ? this.keys.matches(data, id) : false) || matchesKey(data, fallback);

		if (is("tui.select.cancel", "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "a") || matchesKey(data, "tab")) {
			this.view = this.view === "all" ? "anomalies" : "all";
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "r")) {
			this.onReset?.();
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "f")) {
			this.fullscreen = !this.fullscreen;
			this.onToggleFullscreen?.(this.fullscreen);
			this.tui.requestRender();
			return;
		}

		let move = 0;
		if (is("tui.select.up", "up") || matchesKey(data, "k")) move = -1;
		else if (is("tui.select.down", "down") || matchesKey(data, "j")) move = 1;
		else if (is("tui.select.pageUp", "pageUp")) move = -this.pageSize;
		else if (is("tui.select.pageDown", "pageDown")) move = this.pageSize;
		else if (matchesKey(data, "g") || matchesKey(data, "home")) move = -Infinity;
		else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) move = Infinity;
		else return;

		this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + move));
		this.tui.requestRender();
	}

	private renderSummaryLine(stats: CacheSessionStats): string {
		const th = this.theme;
		const sep = th.fg("dim", " · ");
		const parts: string[] = [];

		if (stats.hitPct !== null) {
			parts.push(th.fg(hitColorToken(stats.hitPct), `${stats.hitPct}% hit`));
		} else {
			parts.push(th.fg("dim", "n/a hit"));
		}

		parts.push(`${fmtCompactTokens(stats.cacheRead)}/${fmtCompactTokens(stats.promptTotal)} read`);
		parts.push(`${fmtCompactTokens(stats.cacheWrite)} write`);
		parts.push(`${stats.calls} ${stats.calls === 1 ? "call" : "calls"}`);

		if (stats.anomalyCount > 0) {
			parts.push(th.fg("warning", `${stats.anomalyCount} ${stats.anomalyCount === 1 ? "anomaly" : "anomalies"}`));
		} else {
			parts.push(th.fg("dim", "0 anomalies"));
		}

		const warmth = this.source.cacheWarmth?.(this.now()) ?? null;
		if (warmth !== null) {
			if (warmth.active && warmth.remainingMs > 0) {
				const token = warmth.remainingMs < WARMTH_WARNING_MS ? "warning" : "success";
				parts.push(th.fg(token, `warm ${formatWarmthDuration(warmth.remainingMs)}`));
			} else {
				parts.push(th.fg("dim", "cold"));
			}
		}

		return parts.join(sep);
	}

	private renderBodyLines(items: readonly CacheCallRecord[], innerWidth: number): string[] {
		const th = this.theme;
		if (items.length === 0) {
			const emptyMsg = this.view === "anomalies"
				? "No cache anomalies recorded."
				: "No cache calls recorded yet.";
			return [th.fg("dim", emptyMsg)];
		}

		// Newest first for live debugging.
		const ordered = [...items].reverse();

		const idxWidth = Math.max(
			3,
			...ordered.map((rec) => `#${rec.callIndex}`.length),
		);
		const modelWidth = Math.min(
			MAX_MODEL_COL_WIDTH,
			Math.max(5, ...ordered.map((rec) => shortModelName(rec.model).length)),
		);
		const tokensWidth = Math.max(
			5,
			...ordered.map((rec) =>
				rec.cause === "usage_unavailable"
					? 1
					: `${fmtCompactTokens(rec.cacheRead)}/${fmtCompactTokens(rec.totalPromptTokens)}`.length,
			),
		);

		const detailWidth = Math.max(1, innerWidth - DETAIL_INDENT.length);
		const lines: string[] = [];

		for (const rec of ordered) {
			const idxStr = th.fg("dim", `#${rec.callIndex}`.padStart(idxWidth));
			const modelLabel = truncateToWidth(shortModelName(rec.model), modelWidth, "…");
			const modelPad = " ".repeat(Math.max(0, modelWidth - visibleWidth(modelLabel)));
			const modelStr = `${modelLabel}${modelPad}`;

			let hitStr: string;
			if (rec.cause === "usage_unavailable" || rec.hitPct === null) {
				hitStr = th.fg("dim", " n/a");
			} else if (rec.cause === "cold_start" || rec.cause === "below_min_tokens") {
				hitStr = th.fg("dim", `${rec.hitPct}%`.padStart(4));
			} else {
				hitStr = th.fg(hitColorToken(rec.hitPct), `${rec.hitPct}%`.padStart(4));
			}

			const rawTokens = rec.cause === "usage_unavailable"
				? "-"
				: `${fmtCompactTokens(rec.cacheRead)}/${fmtCompactTokens(rec.totalPromptTokens)}`;
			const tokensStr = th.fg("muted", rawTokens.padStart(tokensWidth));

			let causeStr: string;
			let tagStr = "";
			const formattedTag = formatTag(rec.tag);
			if (rec.isAnomaly) {
				const severity = rec.hitPct !== null && rec.hitPct < 35 ? "error" : "warning";
				causeStr = th.fg(severity, rec.cause);
				if (formattedTag) {
					tagStr = ` ${th.fg(severity, formattedTag)}`;
				}
			} else {
				causeStr = th.fg("dim", rec.cause);
				if (formattedTag) {
					tagStr = ` ${th.fg("dim", formattedTag)}`;
				}
			}

			lines.push(`${idxStr}  ${modelStr}  ${hitStr}  ${tokensStr}  ${causeStr}${tagStr}`);

			if (rec.detail) {
				const cleanDetail = sanitizeInline(rec.detail);
				if (cleanDetail) {
					const wrapped = wrapTextWithAnsi(cleanDetail, detailWidth);
					for (const segment of wrapped) {
						lines.push(`${DETAIL_INDENT}${th.fg("muted", segment)}`);
					}
				}
			}
		}

		return lines;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(0, Math.floor(width));
		if (safeWidth === 0) return [];

		const th = this.theme;
		const inner = Math.max(1, safeWidth - 4);
		const row = (text: string) =>
			`${th.fg("border", "│")} ${truncateToWidth(text, inner, "…", true)} ${th.fg("border", "│")}`;
		const rule = (left: string, right: string) =>
			th.fg("border", `${left}${"─".repeat(Math.max(0, safeWidth - 2))}${right}`);

		const stats = this.source.sessionStats();
		const records = this.source.getRecords();
		const anomalies = this.source.getAnomalies();

		const filterBadge = this.view === "all"
			? th.fg("muted", `All (${records.length})`)
			: th.fg(anomalies.length > 0 ? "warning" : "muted", `Anomalies (${anomalies.length})`);

		const titleLine = `${th.bold(th.fg("accent", "Prefix KV Cache"))}  ${filterBadge}`;
		const summaryLine = this.renderSummaryLine(stats);
		const headerLines = [titleLine, summaryLine];

		if (records.length > 0) {
			const sparkMax = Math.max(1, Math.min(DEFAULT_SPARKLINE_POINTS, inner - 7));
			headerLines.push(`${th.fg("dim", "Trend")}  ${renderHitSparkline(records, th, sparkMax)}`);
		}

		const activeItems = this.view === "anomalies" ? anomalies : records;
		const allBodyLines = this.renderBodyLines(activeItems, inner);
		const height = this.viewportHeight(headerLines.length);
		this.pageSize = height;
		this.maxScroll = Math.max(0, allBodyLines.length - height);
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
		const visibleBody = allBodyLines.slice(this.scroll, this.scroll + height);

		const scrollSuffix = this.maxScroll > 0
			? ` · ${this.scroll + 1}-${this.scroll + visibleBody.length}/${allBodyLines.length}`
			: "";
		const footerText = `a toggle all/anomalies · r reset · ↑/↓ scroll · f fullscreen · q/esc close${scrollSuffix}`;

		const framed = [
			rule("╭", "╮"),
			...headerLines.map(row),
			rule("├", "┤"),
			...visibleBody.map(row),
			rule("├", "┤"),
			row(th.fg("dim", footerText)),
			rule("╰", "╯"),
		];

		return framed.map((line) => truncateToWidth(line, safeWidth, ""));
	}
}

export function cacheOverlayOptions(fullscreen: boolean): OverlayOptions {
	return fullscreen
		? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
		: { anchor: "center", width: "90%", maxHeight: "75%" };
}

/**
 * Opens the `/cache` TUI overlay when `ctx.ui.custom` is available, or falls
 * back to `ctx.ui.notify` with the plain-text cache report otherwise.
 */
export async function openCacheOverlay(
	ctx: ExtensionContext,
	source: CacheOverlaySource,
	options?: OpenCacheOverlayOptions,
): Promise<void> {
	const initialView: CacheOverlayView = options?.initialView ?? "all";
	if (ctx.hasUI === false || typeof ctx.ui?.custom !== "function") {
		ctx.ui?.notify?.(
			source.formatCacheReport(initialView === "anomalies" ? "anomalies" : "summary"),
			"info",
		);
		return;
	}

	let fullscreen = false;
	await ctx.ui.custom<undefined>(
		(tui, theme, keybindings, done) => {
			fullscreen = tui.mode === "fullscreen";
			return new CacheOverlay({
				tui,
				theme,
				source,
				keybindings,
				initialView,
				fullscreen,
				onClose: () => done(undefined),
				onReset: () => {
					source.reset();
					options?.onReset?.();
				},
				onToggleFullscreen: (next) => {
					fullscreen = next;
				},
			});
		},
		{
			overlay: true,
			overlayOptions: () => cacheOverlayOptions(fullscreen),
		},
	);
}
