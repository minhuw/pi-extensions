/**
 * Theme-aware statusline footer for Pi.
 *
 * Visual language is borrowed from pikit's footer: left/right justified rows,
 * a positional RGB gradient context bar, per-level thinking color (rainbow at
 * max/xhigh), a hairline rule, and Nerd Font icons with ASCII fallbacks.
 * Metrics remain ours: TTFT/TTFB, token-weighted throughput, cache ratio,
 * session cost, and working-tree diff.
 *
 * Full mode:
 *   model  HIGH  (provider)                         ▉▉▉░░░  8.2% / 1.05M
 *   ────────────────────────────────────────────
 *   μ 4.2s  28.9 tok/s                    $0.75  96% cache  9 turns
 *   main  +42 −17                         5 touched  ~/code/my-project
 *
 * Compact mode:
 *   model  HIGH            ▉▉▉░░░  42%  $1.23  12m
 *
 * Usage:
 *   /footer            toggle on/off
 *   /footer full       multi-line layout (default)
 *   /footer compact    1-line layout
 *   /footer off        restore pi's default footer
 *   /footer debug      show metric-collection internals
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Mode = "full" | "compact" | "off";

const BAR_WIDTH = 18;
const COMPACT_BAR_WIDTH = 10;
const RESET = "\x1b[0m";

type ThemeToken = Parameters<Theme["fg"]>[0];
type Rgb = { r: number; g: number; b: number };

// ── formatting helpers ──────────────────────────────────────────────

export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function fmtCost(usd: number): string {
	return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	return `${h}h ${String(mins % 60).padStart(2, "0")}m`;
}

function rgbFg(color: Rgb): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

function hexToRgb(hex: string): Rgb | null {
	const value = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

export function hexFg(hex: string, text: string): string {
	const rgb = hexToRgb(hex);
	return rgb ? `${rgbFg(rgb)}${text}${RESET}` : text;
}

function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function mix(start: Rgb, end: Rgb, t: number): Rgb {
	return { r: lerp(start.r, end.r, t), g: lerp(start.g, end.g, t), b: lerp(start.b, end.b, t) };
}

function positionColor(pos: number, width: number, start: Rgb, mid: Rgb, end: Rgb, midFrac = 0.55): Rgb {
	const t = pos / Math.max(width - 1, 1);
	if (t <= midFrac) return mix(start, mid, t / midFrac);
	return mix(mid, end, (t - midFrac) / Math.max(1 - midFrac, 0.0001));
}

export function resolveThemeRgb(theme: Theme, token: ThemeToken): Rgb | null {
	try {
		const probed = theme.fg(token, "X");
		const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(probed);
		if (!match) return null;
		return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
	} catch {
		return null;
	}
}

const FALLBACK_GRADIENT = {
	start: { r: 0x7d, g: 0xce, b: 0xa0 },
	mid: { r: 0xf5, g: 0xb0, b: 0x41 },
	end: { r: 0xae, g: 0x4f, b: 0x2f },
	unfilled: { r: 0x4e, g: 0x4c, b: 0x49 },
};

export function gradientBar(pct: number, width: number, theme?: Theme): string {
	const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width);
	const start = (theme && resolveThemeRgb(theme, "success")) ?? FALLBACK_GRADIENT.start;
	const mid = (theme && resolveThemeRgb(theme, "warning")) ?? FALLBACK_GRADIENT.mid;
	const end = (theme && resolveThemeRgb(theme, "error")) ?? FALLBACK_GRADIENT.end;
	const unfilled = (theme && resolveThemeRgb(theme, "dim")) ?? FALLBACK_GRADIENT.unfilled;
	let bar = "";
	for (let i = 0; i < width; i++) {
		bar += i < filled
			? rgbFg(positionColor(i, width, start, mid, end)) + "▉"
			: rgbFg(unfilled) + "▉";
	}
	return `${bar}${RESET}`;
}

export function rainbow(text: string): string {
	const chars = [...text];
	const visible = chars.filter((char) => char !== " " && char !== ":").length;
	let result = "";
	let colorIndex = 0;
	for (const char of chars) {
		if (char === " " || char === ":") {
			result += char;
			continue;
		}
		const hue = (colorIndex / Math.max(visible - 1, 1)) * 300;
		const sat = 0.85;
		const light = 0.65;
		const a = sat * Math.min(light, 1 - light);
		const channel = (n: number) => {
			const k = (n + hue / 30) % 12;
			return Math.round((light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)) * 255);
		};
		result += rgbFg({ r: channel(0), g: channel(8), b: channel(4) }) + char;
		colorIndex += 1;
	}
	return `${result}${RESET}`;
}

export function formatPath(cwd: string, home = os.homedir()): string {
	if (cwd === home) return "~";
	const prefix = home.endsWith(path.sep) ? home : home + path.sep;
	if (!cwd.startsWith(prefix)) return cwd;
	return `~/${cwd.slice(prefix.length).replaceAll("\\", "/")}`;
}

export function alignRow(left: string, right: string, width: number): string {
	const inner = Math.max(0, width - 2);
	if (!right) return truncateToWidth(` ${truncateToWidth(left, inner)}`, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= inner) return truncateToWidth(` ${truncateToWidth(right, inner)} `, width);
	const leftStr = truncateToWidth(left, Math.max(0, inner - rightWidth - 1));
	const pad = Math.max(1, inner - visibleWidth(leftStr) - rightWidth);
	return truncateToWidth(` ${leftStr}${" ".repeat(pad)}${right} `, width);
}

export function hairline(width: number, theme?: Theme): string {
	const color = (theme && resolveThemeRgb(theme, "borderMuted")) ?? FALLBACK_GRADIENT.unfilled;
	return `${rgbFg(color)}${"─".repeat(Math.max(0, width))}${RESET}`;
}

function cluster(parts: Array<string | false | null | undefined>, sep: string): string {
	return parts.filter((part): part is string => Boolean(part)).join(sep);
}

// ── session stats ───────────────────────────────────────────────────
//
// Walking the full branch is O(session size), so results are cached
// keyed by the branch's leaf entry id: the leaf changes exactly when a
// new entry is appended (or on fork/tree-nav/compaction), which means
// renders during streaming — the hot path — always hit the cache.
// Only durationMs is recomputed per render (Date.now() moves).

interface Stats {
	input: number;
	output: number;
	cost: number;
	cacheRead: number;
	reasoning: number;
	turns: number;
	compactions: number;
	errors: number;
	toolCalls: number;
	files: number;
	durationMs: number;
}

function addUsage(stats: Stats, usage: Usage | undefined): void {
	if (!usage) return;
	stats.input += usage.input;
	stats.output += usage.output;
	stats.cacheRead += usage.cacheRead;
	stats.reasoning += usage.reasoning ?? 0;
	stats.cost += usage.cost.total;
}

interface StatsCache {
	leafId: string | null;
	firstTs: number | undefined;
	stats: Stats;
}

interface SessionState {
	statsCache?: StatsCache;
	metrics: StreamMetrics;
	gitStat: GitStat;
	gitStatAt: number;
	gitStatCwd: string;
	serviceTier?: string;
	requestRender?: () => void;
}

function collectStats(ctx: ExtensionContext, state: SessionState): Stats {
	const leafId = ctx.sessionManager.getLeafId();
	if (state.statsCache && state.statsCache.leafId === leafId) {
		state.statsCache.stats.durationMs = state.statsCache.firstTs
			? Math.max(0, Date.now() - state.statsCache.firstTs)
			: 0;
		return state.statsCache.stats;
	}

	const s: Stats = {
		input: 0,
		output: 0,
		cost: 0,
		cacheRead: 0,
		reasoning: 0,
		turns: 0,
		compactions: 0,
		errors: 0,
		toolCalls: 0,
		files: 0,
		durationMs: 0,
	};
	const files = new Set<string>();
	let firstTs: number | undefined;

	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "compaction") {
			s.compactions++;
			addUsage(s, e.usage);
			continue;
		}
		if (e.type === "branch_summary") {
			addUsage(s, e.usage);
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.timestamp && !firstTs) firstTs = m.timestamp;

		if (m.role === "user") {
			s.turns++;
		} else if (m.role === "assistant") {
			const a = m as AssistantMessage;
			addUsage(s, a.usage);
			for (const block of a.content ?? []) {
				if (block.type !== "toolCall") continue;
				s.toolCalls++;
				const args = block.arguments as Record<string, unknown>;
				if (typeof args.path === "string") files.add(args.path);
			}
		} else if (m.role === "toolResult") {
			addUsage(s, m.usage);
			if (m.isError) s.errors++;
		}
	}

	s.files = files.size;
	s.durationMs = firstTs ? Math.max(0, Date.now() - firstTs) : 0;
	state.statsCache = { leafId, firstTs, stats: s };
	return s;
}

// ── streaming metrics (TTFT + tokens/sec) ──────────────────────────
//
// Measured passively from pi's event stream:
//   before_provider_headers  → request about to be sent (per LLM call).
//                              Some providers abstract HTTP away and never
//                              fire this; message_start is the fallback marker.
//   message_update (*_delta) → first streamed token (text/thinking/toolcall)
//   message_end (assistant)  → exact usage.output + stream end time
//
// Weighted avg tok/s = Σ output tokens / Σ stream durations, i.e. a
// token-weighted mean over all completed requests in this session.

interface StreamMetrics {
	requestSentAt: number;
	firstTokenAt: number;
	curTtftMs: number | null; // TTFT of the in-flight request, if measured
	lastTtftMs: number | null;
	lastTtfbMs: number | null; // response-headers time, when the provider exposes it
	lastTokPerSec: number | null;
	totalOutput: number;
	totalStreamMs: number;
	totalTtftMs: number; // Σ TTFT over completed requests (for mean)
	ttftCount: number;
	requests: number;
	headersSeen: number; // how often before_provider_headers fired (diagnostic)
	responsesSeen: number; // how often after_provider_response fired (diagnostic)
}

function freshMetrics(): StreamMetrics {
	return {
		requestSentAt: 0,
		firstTokenAt: 0,
		curTtftMs: null,
		lastTtftMs: null,
		lastTtfbMs: null,
		lastTokPerSec: null,
		totalOutput: 0,
		totalStreamMs: 0,
		totalTtftMs: 0,
		ttftCount: 0,
		requests: 0,
		headersSeen: 0,
		responsesSeen: 0,
	};
}

function avgTokPerSec(metrics: StreamMetrics): number | null {
	if (metrics.totalStreamMs <= 0 || metrics.totalOutput <= 0) return null;
	return metrics.totalOutput / (metrics.totalStreamMs / 1000);
}

function avgTtftMs(metrics: StreamMetrics): number | null {
	if (metrics.ttftCount === 0) return null;
	return metrics.totalTtftMs / metrics.ttftCount;
}

function fmtTtft(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokPerSec(tps: number): string {
	return `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
}

// ── git working-tree state (async, cached) ─────────────────────────
// Render must stay synchronous, so diff stats are refreshed in the
// background at most every 15s and the last value is painted.

interface GitStat {
	status: "pending" | "clean" | "dirty" | "unavailable";
	files?: number;
	adds?: number;
	dels?: number;
	ahead: number;
	behind: number;
}

// Extension modules are cached within the process, while pi-subagents binds a
// fresh extension activation to every child AgentSession. Keep telemetry keyed
// by session so child lifecycle and stream events cannot reset or corrupt the
// interactive parent's footer. The map also preserves metrics across /reload.
const sessionStates = new Map<string, SessionState>();

function freshSessionState(previous?: SessionState): SessionState {
	return {
		metrics: previous?.metrics ?? freshMetrics(),
		gitStat: { status: "pending", ahead: 0, behind: 0 },
		gitStatAt: 0,
		gitStatCwd: "",
		serviceTier: previous?.serviceTier,
	};
}

function getSessionState(ctx: ExtensionContext): SessionState | undefined {
	return sessionStates.get(ctx.sessionManager.getSessionId());
}

export function parseGitShortstat(stdout: string): Pick<GitStat, "files" | "adds" | "dels"> {
	const files = /(\d+) files? changed/.exec(stdout);
	const adds = /(\d+) insertions?\(\+\)/.exec(stdout);
	const dels = /(\d+) deletions?\(-\)/.exec(stdout);
	return {
		files: files ? Number(files[1]) : 0,
		adds: adds ? Number(adds[1]) : 0,
		dels: dels ? Number(dels[1]) : 0,
	};
}

export function parseGitStatus(stdout: string): "clean" | "dirty" {
	return stdout.length === 0 ? "clean" : "dirty";
}

/** `git rev-list --left-right --count @{upstream}...HEAD` → behind then ahead. */
export function parseGitAheadBehind(stdout: string): { ahead: number; behind: number } {
	const match = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim());
	if (!match) return { ahead: 0, behind: 0 };
	return { behind: Number(match[1]), ahead: Number(match[2]) };
}

export function extractServiceTier(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	const raw = record.service_tier ?? record.serviceTier;
	if (typeof raw !== "string") return undefined;
	const tier = raw.trim();
	return tier || undefined;
}

const STANDARD_TIERS = new Set(["standard", "default", "auto", "standard_only"]);

export function displayServiceTier(tier: string | undefined): string | undefined {
	if (!tier) return undefined;
	const normalized = tier.trim().toLowerCase();
	if (!normalized || STANDARD_TIERS.has(normalized)) return undefined;
	return normalized === "priority" ? "FAST" : normalized.toUpperCase();
}

function refreshGitStat(cwd: string, state: SessionState) {
	const now = Date.now();
	if (state.gitStatCwd === cwd && now - state.gitStatAt < 15_000) return;
	state.gitStatAt = now;
	state.gitStatCwd = cwd;
	state.gitStat = { status: "pending", ahead: 0, behind: 0 };
	const opts = { cwd, timeout: 5000 };
	let status: GitStat["status"] | undefined;
	let shortstat: Pick<GitStat, "files" | "adds" | "dels"> | undefined;
	let aheadBehind = { ahead: 0, behind: 0 };
	let pending = 3;
	const finish = () => {
		pending -= 1;
		if (pending > 0) return;
		state.gitStat = {
			status: status ?? "unavailable",
			...(shortstat ?? {}),
			...aheadBehind,
		};
		state.requestRender?.();
	};
	execFile("git", ["status", "--porcelain=v1", "--untracked-files=normal"], opts, (err, stdout) => {
		status = err ? "unavailable" : parseGitStatus(stdout);
		finish();
	});
	execFile("git", ["diff", "--shortstat", "HEAD"], opts, (err, stdout) => {
		shortstat = err ? undefined : parseGitShortstat(stdout);
		finish();
	});
	execFile("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], opts, (err, stdout) => {
		aheadBehind = err ? { ahead: 0, behind: 0 } : parseGitAheadBehind(stdout);
		finish();
	});
}

// ── icons ──────────────────────────────────────────────────────────
// Nerd Fonts when the terminal is known to have them; otherwise ASCII.
// Override with STATUSLINE_NERD_FONTS=1|0 (FOOTER_NERD_FONTS is also accepted).

type IconSet = {
	compact: string;
	elapsed: string;
	turns: string;
	input: string;
	output: string;
	cache: string;
	cost: string;
	ttft: string;
	ttfb: string;
	speed: string;
	last: string;
	calls: string;
	err: string;
	ok: string;
	branch: string;
	file: string;
	cwd: string;
};

const NERD_ICONS: IconSet = {
	compact: "\uF0615", // md-arrow-collapse
	elapsed: "\uF0954", // md-clock
	turns: "\uF0368", // md-message-reply-text
	input: "\uF005E", // md-arrow-up-thick
	output: "\uF0046", // md-arrow-down-thick
	cache: "\uF140B", // md-lightning-bolt
	cost: "\uF01C1", // md-currency-usd
	ttft: "\uF051B", // md-timer-outline
	ttfb: "\uF04E1", // md-swap-horizontal
	speed: "\uF04C5", // md-speedometer
	last: "\uF02DA", // md-history
	calls: "\uF05B7", // md-wrench
	err: "\uF0159", // md-close-circle
	ok: "\uF0133", // md-checkbox-marked-circle
	branch: "\uF062C", // md-source-branch
	file: "\uF0224", // md-file-outline
	cwd: "\uF0770", // md-folder-open
} as const;

const ASCII_ICONS: IconSet = {
	compact: "×",
	elapsed: "⏱",
	turns: "#",
	input: "↑",
	output: "↓",
	cache: "⚡",
	cost: "$",
	ttft: "⏱",
	ttfb: "⇄",
	speed: "»",
	last: "↺",
	calls: "⚙",
	err: "✕",
	ok: "✓",
	branch: "⎇",
	file: "▤",
	cwd: "⌂",
} as const;

export function hasNerdFonts(): boolean {
	const override = process.env.STATUSLINE_NERD_FONTS ?? process.env.FOOTER_NERD_FONTS;
	if (override === "1") return true;
	if (override === "0") return false;
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;
	const termProg = (process.env.TERM_PROGRAM || "").toLowerCase();
	const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty", "foot", "rio", "contour"];
	if (nerdTerms.some((name) => termProg.includes(name))) return true;
	const term = (process.env.TERM || "").toLowerCase();
	return ["xterm-kitty", "xterm-ghostty", "alacritty", "foot", "rio", "contour"].some((name) => term.includes(name));
}

function icons(): IconSet {
	return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

function glyph(theme: Theme, icon: string, color?: ThemeToken): string {
	return color ? theme.fg(color, theme.bold(icon)) : theme.bold(icon);
}

// ── rendering ───────────────────────────────────────────────────────

const THINKING_CAPS: Record<string, string> = {
	off: "OFF",
	minimal: "MIN",
	low: "LOW",
	medium: "MED",
	high: "HIGH",
	xhigh: "XHIGH",
	max: "MAX",
};

export function thinkingCaps(level: string): string {
	return THINKING_CAPS[level] ?? level.toUpperCase();
}

export function renderThinking(theme: Theme, level: string): string {
	const text = thinkingCaps(level);
	if (level === "max" || level === "xhigh") return rainbow(text);
	if (level === "high") return hexFg("#afb9fe", text);
	if (level === "medium") return theme.fg("success", text);
	if (level === "low") return theme.fg("warning", text);
	if (level === "off") return theme.fg("dim", text);
	return theme.fg("muted", text);
}

function renderModelLabel(
	ctx: ExtensionContext,
	theme: Theme,
	includeProvider: boolean,
	live = false,
	queued = false,
	serviceTier?: string,
): string {
	const model = ctx.model;
	const liveMark = live ? theme.fg("success", theme.bold("●")) + "  " : "";
	const queuedMark = queued ? theme.fg("warning", "queued") + "  " : "";
	if (!model) return liveMark + queuedMark + theme.fg("accent", theme.bold("no-model"));

	const name = theme.fg("accent", theme.bold(model.id));
	const thinking = model.reasoning ? `  ${renderThinking(theme, ctx.thinkingLevel ?? "off")}` : "";
	const tier = displayServiceTier(serviceTier);
	const tierMark = tier ? `  ${theme.fg("warning", theme.bold(tier))}` : "";
	const provider = includeProvider && model.provider ? theme.fg("dim", `  (${model.provider})`) : "";
	return liveMark + queuedMark + name + thinking + tierMark + provider;
}

function renderContext(
	theme: Theme,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
	barWidth: number,
	compactions: number,
	compactIcon: string,
): string {
	const compact = glyph(theme, compactIcon, compactions > 0 ? "warning" : "dim") + " " +
		theme.fg(compactions > 0 ? "warning" : "dim", `${compactions}×`);
	if (usage?.percent != null) {
		const pct = usage.percent;
		const used = fmtTokens(usage.tokens ?? 0);
		const window = fmtTokens(usage.contextWindow);
		return cluster([
			compact,
			gradientBar(pct, barWidth, theme),
			theme.fg("muted", `${pct.toFixed(1)}%`),
			theme.fg("dim", `${used}/${window}`),
		], "  ");
	}
	if (usage?.contextWindow) {
		return cluster([compact, theme.fg("dim", `/ ${fmtTokens(usage.contextWindow)}`)], "  ");
	}
	return compact;
}

function renderCompact(
	ctx: ExtensionContext,
	theme: Theme,
	width: number,
	state: SessionState,
): string {
	const set = icons();
	const s = collectStats(ctx, state);
	const usage = ctx.getContextUsage();
	const sep = "  ";
	const left = renderModelLabel(ctx, theme, false, !ctx.isIdle(), ctx.hasPendingMessages(), state.serviceTier);
	const right = cluster([
		renderContext(theme, usage, COMPACT_BAR_WIDTH, s.compactions, set.compact),
		theme.fg("warning", `${glyph(theme, set.cost, "warning")} ${fmtCost(s.cost)}`),
		theme.fg("dim", fmtDuration(s.durationMs)),
	], sep);
	return alignRow(left, right, width);
}

function ttftColor(ms: number): "success" | "warning" | "error" {
	if (ms < 2_000) return "success";
	if (ms < 8_000) return "warning";
	return "error";
}

function renderFull(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	state: SessionState,
): string[] {
	const set = icons();
	const s = collectStats(ctx, state);
	const usage = ctx.getContextUsage();
	const sep = "  ";

	const line1 = alignRow(
		renderModelLabel(ctx, theme, true, !ctx.isIdle(), ctx.hasPendingMessages(), state.serviceTier),
		renderContext(theme, usage, BAR_WIDTH, s.compactions, set.compact),
		width,
	);

	const { metrics } = state;
	const avgTtft = avgTtftMs(metrics);
	const avg = avgTokPerSec(metrics);
	const totalIn = s.input + s.cacheRead;
	const cachePct = totalIn > 0 ? Math.round((s.cacheRead / totalIn) * 100) : null;
	const cacheColor: ThemeToken = cachePct == null ? "dim" : cachePct >= 70 ? "success" : cachePct >= 40 ? "warning" : "dim";

	const perf = cluster([
		theme.fg("dim", `${glyph(theme, set.turns)} ${s.turns}  ${glyph(theme, set.elapsed)} ${fmtDuration(s.durationMs)}`),
		avgTtft != null
			? theme.fg(ttftColor(avgTtft), `${glyph(theme, set.ttft, ttftColor(avgTtft))} μ ${fmtTtft(avgTtft)}`)
				+ (metrics.lastTtftMs != null && metrics.ttftCount > 1 ? theme.fg("dim", ` ${glyph(theme, set.last)} ${fmtTtft(metrics.lastTtftMs)}`) : "")
			: theme.fg("dim", `${glyph(theme, set.ttft)} —`),
		metrics.lastTtfbMs != null ? theme.fg("dim", `${glyph(theme, set.ttfb)} ${fmtTtft(metrics.lastTtfbMs)}`) : "",
		avg != null
			? theme.fg("success", `${glyph(theme, set.speed, "success")} μ ${fmtTokPerSec(avg)}`)
				+ (metrics.lastTokPerSec != null && metrics.requests > 1 ? theme.fg("dim", ` ${glyph(theme, set.last)} ${fmtTokPerSec(metrics.lastTokPerSec)}`) : "")
			: theme.fg("dim", `${glyph(theme, set.speed)} —`),
		s.toolCalls > 0
			? theme.fg("syntaxFunction", `${glyph(theme, set.calls, "syntaxFunction")} ${s.toolCalls}`)
			: theme.fg("dim", `${glyph(theme, set.calls)} 0`),
		s.toolCalls > 0
			? (s.errors > 0
				? theme.fg("error", `${glyph(theme, set.err, "error")} ${s.errors} (${((s.errors / s.toolCalls) * 100).toFixed(1)}%)`)
				: theme.fg("success", `${glyph(theme, set.ok, "success")} 0`))
			: "",
	], sep);

	const money = cluster([
		theme.fg("warning", `${glyph(theme, set.cost, "warning")} ${fmtCost(s.cost)}`)
			+ (s.turns > 0 ? theme.fg("dim", ` (~${fmtCost(s.cost / s.turns)}/turn)`) : ""),
		theme.fg("toolDiffAdded", `${glyph(theme, set.input, "toolDiffAdded")} ${fmtTokens(s.input)}`)
			+ " "
			+ theme.fg("toolDiffRemoved", `${glyph(theme, set.output, "toolDiffRemoved")} ${fmtTokens(s.output)}`)
			+ (s.cacheRead > 0 ? " " + theme.fg(cacheColor, `${glyph(theme, set.cache, cacheColor)}${fmtTokens(s.cacheRead)}`) : ""),
		s.reasoning > 0 ? theme.fg("muted", `${fmtTokens(s.reasoning)} think`) : "",
		cachePct != null ? theme.fg(cacheColor, `${cachePct}%`) : "",
	], sep);

	const line2 = alignRow(perf, money, width);

	refreshGitStat(ctx.cwd, state);
	const branch = footerData.getGitBranch();
	const gitStatus = state.gitStat.status;
	const gitColor: ThemeToken = gitStatus === "clean"
		? "success"
		: gitStatus === "dirty"
			? "warning"
			: gitStatus === "unavailable"
				? "error"
				: "dim";
	const gitLabel = gitStatus === "clean"
		? theme.fg("success", `${glyph(theme, set.ok, "success")} clean`)
		: gitStatus === "dirty"
			? state.gitStat.adds || state.gitStat.dels
				? theme.fg("warning", `${theme.fg("toolDiffAdded", `+${state.gitStat.adds ?? 0}`)} ${theme.fg("toolDiffRemoved", `-${state.gitStat.dels ?? 0}`)}`)
				: theme.fg("warning", "dirty")
			: gitStatus === "unavailable"
				? theme.fg("error", "git ?")
				: theme.fg("dim", "git …");
	const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
	const gitLeft = cluster([
		branch
			? theme.fg(gitColor, `${glyph(theme, set.branch, gitColor)} ${branch}`)
			: theme.fg("dim", `${glyph(theme, set.branch)} no git`),
		branch ? gitLabel : "",
		state.gitStat.ahead > 0 || state.gitStat.behind > 0
			? theme.fg("success", `↑${state.gitStat.ahead}`) + " " + theme.fg("warning", `↓${state.gitStat.behind}`)
			: "",
		...statuses.map((status) => theme.fg("accent", status)),
	], "  ");
	const gitRight = cluster([
		s.files > 0 ? theme.fg("dim", `${glyph(theme, set.file)} ${s.files} touched`) : "",
		theme.fg("dim", `${glyph(theme, set.cwd)} ${formatPath(ctx.cwd)}`),
	], sep);
	const line3 = alignRow(gitLeft, gitRight, width);

	return [line1, hairline(width, theme), line2, line3];
}

// ── extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: Mode = "full";
	let installedCtx: ExtensionContext | undefined;

	function install(ctx: ExtensionContext, state: SessionState) {
		if (ctx.mode !== "tui" || installedCtx === ctx) return;
		installedCtx = ctx;

		ctx.ui.setFooter((tui, theme, footerData) => {
			state.requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			// Keep duration fresh even when idle
			const timer = setInterval(() => tui.requestRender(), 30_000);
			timer.unref?.();

			return {
				dispose() {
					unsubBranch();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					if (mode === "off") return [];
					return mode === "compact"
						? [renderCompact(ctx, theme, width, state)]
						: renderFull(ctx, theme, footerData, width, state);
				},
			};
		});
	}

	pi.on("session_start", async (event, ctx) => {
		// Programmatic AgentSessions (including @tintinweb/pi-subagents) bind
		// extensions in print mode. This footer is TUI-only, so those activations
		// must not collect provider events or touch the interactive session state.
		if (ctx.mode !== "tui") return;

		installedCtx = undefined; // new session runtime → reinstall
		const sessionId = ctx.sessionManager.getSessionId();
		const previous = sessionStates.get(sessionId);
			const state = freshSessionState(event.reason === "reload" ? previous : undefined);
		sessionStates.set(sessionId, state);
		if (mode !== "off") install(ctx, state);
	});

	// ── streaming metrics collection (TUI session only)

	pi.on("before_provider_request", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		const tier = extractServiceTier(event.payload);
		if (tier) state.serviceTier = tier;
	});

	pi.on("before_provider_headers", (_event, ctx) => {
		const metrics = getSessionState(ctx)?.metrics;
		if (!metrics || ctx.mode !== "tui") return;
		// Request is about to hit the wire (fires once per LLM call;
		// retries reuse the same headers and don't re-fire).
		metrics.headersSeen++;
		metrics.requestSentAt = Date.now();
		metrics.firstTokenAt = 0;
		metrics.curTtftMs = null;
	});

	pi.on("after_provider_response", (_event, ctx) => {
		const metrics = getSessionState(ctx)?.metrics;
		if (!metrics || ctx.mode !== "tui") return;
		// Response headers received (TTFB). Not all providers expose this.
		metrics.responsesSeen++;
		if (metrics.requestSentAt > 0) {
			metrics.lastTtfbMs = Date.now() - metrics.requestSentAt;
		}
	});

	pi.on("message_start", (event, ctx) => {
		const metrics = getSessionState(ctx)?.metrics;
		if (!metrics || ctx.mode !== "tui") return;
		// Fallback start marker for providers that never fire
		// before_provider_headers (stream consumption is beginning).
		if (event.message.role === "assistant" && metrics.requestSentAt === 0) {
			metrics.requestSentAt = Date.now();
		}
	});

	pi.on("message_update", (event, ctx) => {
		const metrics = getSessionState(ctx)?.metrics;
		if (!metrics || ctx.mode !== "tui") return;
		// First content-block start or delta (text/thinking/toolcall)
		// ≈ first token from the provider.
		const t = event.assistantMessageEvent.type;
		if (metrics.firstTokenAt === 0 && (t.endsWith("_delta") || t.endsWith("_start"))) {
			metrics.firstTokenAt = Date.now();
			if (metrics.requestSentAt > 0) {
				metrics.curTtftMs = metrics.firstTokenAt - metrics.requestSentAt;
				metrics.lastTtftMs = metrics.curTtftMs;
			}
		}
	});

	pi.on("message_end", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui" || event.message.role !== "assistant") return;
		const { metrics } = state;
		const usage = (event.message as AssistantMessage).usage;
		const streamStart = metrics.firstTokenAt || metrics.requestSentAt;
		const streamMs = streamStart > 0 ? Date.now() - streamStart : 0;
		// Ignore degenerate samples (no stream observed, or instant responses
		// where duration is too small to yield a meaningful rate).
		if (streamMs >= 50 && usage && usage.output > 0) {
			metrics.totalOutput += usage.output;
			metrics.totalStreamMs += streamMs;
			metrics.lastTokPerSec = usage.output / (streamMs / 1000);
			metrics.requests++;
			if (metrics.curTtftMs != null) {
				metrics.totalTtftMs += metrics.curTtftMs;
				metrics.ttftCount++;
			}
		}
		metrics.requestSentAt = 0;
		metrics.firstTokenAt = 0;
		metrics.curTtftMs = null;
		state.requestRender?.();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		installedCtx = undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessionStates.get(sessionId);
		if (state) state.requestRender = undefined;
		if (event.reason !== "reload") sessionStates.delete(sessionId);
	});

	pi.registerCommand("footer", {
		description: "Statusline footer: /footer [full|compact|off|debug]",
		handler: async (args, ctx) => {
			const next = args.trim().toLowerCase();
			if (next === "debug") {
				const metrics = getSessionState(ctx)?.metrics;
				ctx.ui.notify(
					metrics
						? [
								`mode=${mode}`,
								`headersSeen=${metrics.headersSeen} responsesSeen=${metrics.responsesSeen} requests=${metrics.requests}`,
								`lastTtfb=${metrics.lastTtfbMs ?? "-"} avgTtft=${avgTtftMs(metrics)?.toFixed(0) ?? "-"} lastTtft=${metrics.lastTtftMs ?? "-"} lastTok/s=${metrics.lastTokPerSec?.toFixed(1) ?? "-"}`,
							].join(" | ")
						: `mode=${mode} | metrics unavailable outside the TUI session`,
					"info",
				);
				return;
			}
			if (next === "full" || next === "compact" || next === "off") {
				mode = next as Mode;
			} else if (next === "") {
				mode = mode === "off" ? "full" : "off";
			} else {
				ctx.ui.notify(
					`Unknown /footer argument '${args.trim()}' — usage: /footer [full|compact|off|debug]`,
					"warning",
				);
				return;
			}
			const state = getSessionState(ctx);
			if (mode === "off") {
				installedCtx = undefined;
				if (state) state.requestRender = undefined;
				ctx.ui.setFooter(undefined); // restore pi's default footer
				ctx.ui.notify("Default footer restored", "info");
			} else if (state) {
				installedCtx = undefined; // force reinstall
				install(ctx, state);
				ctx.ui.notify(`Statusline footer: ${mode} mode`, "info");
			}
		},
	});
}
