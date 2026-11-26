/**
 * Theme-aware statusline footer for Pi.
 *
 * Visual language is borrowed from pikit's footer: left/right justified rows,
 * a positional RGB gradient context bar, per-level thinking color (rainbow at
 * max), and Nerd Font icons with ASCII fallbacks; the identity row is
 * a powerline bar on theme bands. Metrics remain ours: TTFT/TTFB, aggregate
 * throughput, cache ratio, session cost, and working-tree diff.
 *
 * Full mode picks a tier from the render width alone (FOOTER_TIERS), so the
 * row count never jitters while streaming. Detail rows share a rail that
 * closes at the last row.
 *   desk (>= 175): identity bar; optional attention/overflow activity; telemetry; workspace.
 *    ├ herder: T2 verify blocked · 3/5 tasks                    rep #dev  ⇌ #ops · 3 in · 2 out
 *    ├ # 13  ◷ 1h 28m  ❯  ⚙ 42  ❯  ⏱ 4.2s (3.8s)  » 28.9 tok/s (31)     $0.75  $0.06/turn  ❮  ↑ 65k  ↓ 31k  ⚡ 120k 65% +18k wr
 *    ╰ ⎇ main wt  +42 −17 ●1 ?2  ❯  subagents: 2 running             ✎ 5 edited  ❮  ⌂ ~/…/my-project  ❮  #a1b2c3d4
 *   laptop: identity bar; optional activity; essentials.
 *    ╰ ⎇ main  +42 −17  ❯  $0.75  ❯  # 13  ◷ 1h 28m      ⏱ 4.2s  » 28.9 tok/s  ❮  ⚡ 65%  ❮  ⌂ ~/…/my-project
 *   phone (<= 71): one plain-text row.
 *    opus-5-5 · HIGH · 42.5% · $0.75 · herder blocked
 *
 * Compact mode: the bar alone.
 *   ⊛ gpt-6.1-terra  ϟ OFF  ∴ XHIGH        English  ━━━━╸───▕─  42.5%  43k/100k  $1.23  12m
 *
 * Usage:
 *   /footer                   toggle on/off
 *   /footer full              width-adaptive multi-line layout (default)
 *   /footer compact           1-line layout
 *   /footer off               restore pi's default footer
 *   /footer debug             show metric-collection internals
 *   /cache [anomalies|reset]  inspect session prefix KV cache hit rates and miss root causes
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	CacheLensTracker,
	formatWarmthCountdown,
	parseCacheLensReloadSnapshot,
	type CacheLensReloadSnapshot,
} from "./cache-lens.ts";
import { openCacheOverlay } from "./cache-overlay.ts";
import { PROCESS_STATUS_KEY, watchProcesses } from "./processes.ts";
import {
	compactionThresholdPct,
	loadFooterMode,
	saveFooterMode,
	type FooterMode,
} from "./settings.ts";
import { summarizeSwarmBoard, watchSwarmBoard } from "./swarm-board.ts";

const BAR_WIDTH = 18;
const COMPACT_BAR_WIDTH = 10;
const RESET = "\x1b[0m";

type ThemeToken = Parameters<Theme["fg"]>[0];
type Rgb = { r: number; g: number; b: number };

// ── formatting helpers ──────────────────────────────────────────────

// Before Node 26, stripVTControlCharacters leaves colon-separated SGR parameters (`\x1b[38:2::255:0:0m`) in the text.
const stripAnsi = (text: string): string => stripVTControlCharacters(text.replace(/\x1b\[[0-9;:]*m/g, ""));

function fmtTokens(n: number): string {
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

function fmtPhaseElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}m${String(s).padStart(2, "0")}s`;
}

function rgbFg(color: Rgb): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

function rgbBg(color: Rgb): string {
	return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
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

function resolveThemeRgb(theme: Theme, token: ThemeToken): Rgb | null {
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

export interface GradientBarOptions {
	thresholdPct?: number;
	surfaceRgb?: Rgb;
}

export function gradientBar(
	pct: number,
	width: number,
	theme?: Theme,
	options?: GradientBarOptions,
): string {
	const clamped = Math.min(Math.max(pct, 0), 100);
	const exact = (clamped / 100) * width;
	let full = Math.floor(exact);
	const frac = exact - full;
	let hasHalf = false;
	if (frac >= 0.75) {
		full += 1;
	} else if (frac >= 0.25) {
		hasHalf = true;
	}
	const start = (theme && resolveThemeRgb(theme, "success")) ?? FALLBACK_GRADIENT.start;
	const mid = (theme && resolveThemeRgb(theme, "warning")) ?? FALLBACK_GRADIENT.mid;
	const end = (theme && resolveThemeRgb(theme, "error")) ?? FALLBACK_GRADIENT.end;
	const unfilled = (theme && resolveThemeRgb(theme, "dim")) ?? FALLBACK_GRADIENT.unfilled;
	const surfaceRgb = options?.surfaceRgb;
	const trackPrefix = surfaceRgb
		? `${rgbBg(surfaceRgb)}${rgbFg(mix(surfaceRgb, chipInk(surfaceRgb), 0.28))}`
		: rgbFg(unfilled);
	const thresholdPct = options?.thresholdPct;
	const notchIdx = thresholdPct != null && thresholdPct > 0 && thresholdPct < 100 && width >= 8
		? Math.min(width - 1, Math.max(0, Math.round((thresholdPct / 100) * width) - 1))
		: -1;
	const nearThreshold = thresholdPct != null && clamped >= thresholdPct - 5;
	const notchPrefix = nearThreshold
		? rgbFg(mid)
		: surfaceRgb
			? `${rgbBg(surfaceRgb)}${rgbFg(mix(surfaceRgb, chipInk(surfaceRgb), 0.45))}`
			: rgbFg((theme && resolveThemeRgb(theme, "muted")) ?? unfilled);

	let bar = "";
	for (let i = 0; i < width; i++) {
		if (i === notchIdx) {
			bar += `${notchPrefix}▕`;
		} else if (i < full) {
			bar += `${rgbFg(positionColor(i, width, start, mid, end))}━`;
		} else if (hasHalf && i === full) {
			bar += `${rgbFg(positionColor(i, width, start, mid, end))}╸`;
		} else {
			bar += `${trackPrefix}─`;
		}
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

export function formatWorkspacePath(
	cwd: string,
	home = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
	hostname = os.hostname(),
): string {
	const base = formatPath(cwd, home);
	if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) {
		const host = hostname.trim().split(".")[0];
		if (host) return `${host}:${base}`;
	}
	return base;
}

type BarCenter = string | { text: string; pill?: boolean; tint?: Rgb };

export function alignRow(left: string, right: string, width: number, center?: BarCenter): string {
	const inner = Math.max(0, width - 2);
	if (!right) return truncateToWidth(` ${truncateToWidth(left, inner)}`, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= inner) return truncateToWidth(` ${truncateToWidth(right, inner)} `, width);
	const leftStr = truncateToWidth(left, Math.max(0, inner - rightWidth - 1));
	const pad = Math.max(1, inner - visibleWidth(leftStr) - rightWidth);
	const isPill = Boolean(center && typeof center !== "string" && center.pill);
	const rawCenter = typeof center === "string" ? center : center?.text;
	if (rawCenter && visibleWidth(rawCenter) > 0) {
		let centerText: string | undefined;
		if (isPill) {
			if (visibleWidth(rawCenter) + 2 <= pad) centerText = rawCenter;
		} else if (visibleWidth(rawCenter) + 4 <= pad) {
			centerText = rawCenter;
		} else if (pad >= 18) {
			centerText = truncateToWidth(rawCenter, pad - 8, "…");
		}
		if (centerText) {
			const cw = visibleWidth(centerText);
			const minMargin = isPill ? 2 : 4;
			if (cw > 0 && cw + minMargin <= pad) {
				const leftPad = Math.floor((pad - cw) / 2);
				const rightPad = pad - cw - leftPad;
				return truncateToWidth(` ${leftStr}${" ".repeat(leftPad)}${centerText}${" ".repeat(rightPad)}${right} `, width);
			}
		}
	}
	return truncateToWidth(` ${leftStr}${" ".repeat(pad)}${right} `, width);
}

function cluster(parts: Array<string | false | null | undefined>, sep: string): string {
	return parts.filter((part): part is string => Boolean(part)).join(sep);
}

// ── skins ──────────────────────────────────────────────────────────
// A skin draws the identity row, the footer's status bar. The powerline skin
// sets its groups on bands of the theme's tool surface, capped with powerline
// arrows (square ends without Nerd Fonts), and opens it with a chip in the
// model vendor's color. A theme whose surface is the terminal default has no
// band to draw, so the flat skin lays the same groups on the terminal
// background. The rows below stay unfilled either way, so the bar leads.

interface Skin {
	/** Columns the bar spends outside its content: margins, padding, caps, and the minimum gap. */
	chrome: number;
	/** Resolved RGB of a truecolor band surface, if the skin draws one. */
	surfaceRgb?: Rgb;
	bar(left: string, right: string, width: number, center?: BarCenter): string;
	/** A chip that opens the bar's left group, if the skin draws chips. */
	chip?(text: string, color: Rgb): string;
}

const BAND_TOKEN = "toolPendingBg";
const POWERLINE = {
	left: "\u{E0B0}",
	right: "\u{E0B2}",
	roundLeft: "\u{E0B6}",
	roundRight: "\u{E0B4}",
};

function luminance({ r, g, b }: Rgb): number {
	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

const INK_DARK = { r: 0x1b, g: 0x1b, b: 0x1f };
const INK_LIGHT = { r: 0xff, g: 0xff, b: 0xff };

/** Near-black or white, whichever contrasts more with `color`. */
export function chipInk(color: Rgb): Rgb {
	return contrastRatio(INK_DARK, color) >= contrastRatio(INK_LIGHT, color) ? INK_DARK : INK_LIGHT;
}

/** `color`, moved toward black or white just far enough to reach `min` contrast on `surface`. */
export function legibleOn(color: Rgb, surface: Rgb, min = 3): Rgb {
	if (contrastRatio(color, surface) >= min) return color;
	const ink = chipInk(surface);
	for (let step = 1; step < 10; step++) {
		const moved = mix(color, ink, step / 10);
		if (contrastRatio(moved, surface) >= min) return moved;
	}
	return ink;
}

/** The opening and closing escape sequences of a theme token, or "" for each the theme leaves out. */
function tokenAnsi(paint: (text: string) => string): [string, string] {
	try {
		const [open = "", close = ""] = paint("\0").split("\0");
		return [open, close];
	} catch {
		return ["", ""];
	}
}

/** xterm's fixed 256-color palette; the first 16 colors are the terminal's own and cannot be known. */
function xterm256(index: number): Rgb | null {
	if (index < 16 || index > 255) return null;
	if (index >= 232) {
		const v = 8 + (index - 232) * 10;
		return { r: v, g: v, b: v };
	}
	const steps = [0, 95, 135, 175, 215, 255];
	const i = index - 16;
	return { r: steps[Math.floor(i / 36)]!, g: steps[Math.floor(i / 6) % 6]!, b: steps[i % 6]! };
}

/** The color a `\x1b[48;2;…m` or `\x1b[48;5;…m` sequence opens with. */
function backgroundRgb(open: string): Rgb | null {
	const truecolor = /^\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(open);
	if (truecolor) return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
	const indexed = /^\x1b\[48;5;(\d+)m/.exec(open);
	return indexed ? xterm256(Number(indexed[1])) : null;
}

const FLAT_SKIN: Skin = { chrome: 3, bar: alignRow };

/** Soft state-colored pill background mixed into the band's surface so dark and light themes stay cohesive. */
export function pillTintSurface(surfaceRgb: Rgb, tint: Rgb): Rgb {
	const weight = luminance(surfaceRgb) > 0.4 ? 0.14 : 0.19;
	return mix(surfaceRgb, tint, weight);
}

/** The powerline skin on `surface`, a theme background's opening sequence, with `rule` the rule token's sequences. */
function powerlineSkin(surface: string, [ruleOpen, ruleClose]: [string, string], nerd: boolean): Skin {
	const capInk = surface.replace("\x1b[48;", "\x1b[38;");
	const surfaceRgb = backgroundRgb(surface);
	const lifted = new Map<string, string[]>();
	// Theme colors are chosen for the terminal background; lift truecolor text that would fade into the band.
	const lift = (color: string[], targetRgb: Rgb | null = surfaceRgb): string[] => {
		if (!targetRgb || color[1] !== "2") return color;
		const key = `${targetRgb.r},${targetRgb.g},${targetRgb.b}|${color.join(";")}`;
		let legible = lifted.get(key);
		if (!legible) {
			const { r, g, b } = legibleOn({ r: Number(color[2]), g: Number(color[3]), b: Number(color[4]) }, targetRgb);
			legible = ["38", "2", `${r}`, `${g}`, `${b}`];
			lifted.set(key, legible);
		}
		return legible;
	};
	// Rewrites one SGR sequence for the band: a reset or default background reopens the surface,
	// faint is dropped because it would fade into the band, and foregrounds are lifted unless
	// the caller explicitly paired them with a background (intentional contrast calibration).
	const reband = (
		params: string,
		inheritedExplicitBg = false,
		targetSurface = surface,
		targetRgb: Rgb | null = surfaceRgb,
	): { out: string; explicitBg: boolean } => {
		const codes = params === "" ? ["0"] : params.split(";");
		let hasExplicitBg = inheritedExplicitBg;
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i] || "0";
			if (code === "48" && (codes[i + 1] === "2" || codes[i + 1] === "5")) {
				hasExplicitBg = true;
				i += codes[i + 1] === "2" ? 4 : 2;
			} else if (code === "38" && (codes[i + 1] === "2" || codes[i + 1] === "5")) {
				i += codes[i + 1] === "2" ? 4 : 2;
			} else if (code === "0" || code === "49") {
				hasExplicitBg = false;
			}
		}
		const kept: string[] = [];
		let reopen = false;
		let explicitBg = inheritedExplicitBg;
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i] || "0";
			if ((code === "38" || code === "48") && (codes[i + 1] === "2" || codes[i + 1] === "5")) {
				const color = codes.slice(i, i + (codes[i + 1] === "2" ? 5 : 3));
				i += color.length - 1;
				if (code === "48") {
					reopen = false;
					explicitBg = true;
					kept.push(...color);
				} else {
					kept.push(...(hasExplicitBg ? color : lift(color, targetRgb)));
				}
				continue;
			}
			if (code === "0" || code === "49") {
				reopen = true;
				explicitBg = false;
			}
			if (code === "2" || code === "49") continue;
			kept.push(code);
		}
		return {
			out: `${kept.length ? `\x1b[${kept.join(";")}m` : ""}${reopen ? targetSurface : ""}`,
			explicitBg,
		};
	};
	// Padding on both sides of the content, plus the cap.
	const side = nerd ? 3 : 2;
	const chipEnd = `${surface}\x1b[39m`;
	const closeChip = (color: Rgb) => `\x1b[22m${nerd ? `${surface}${rgbFg(color)}${POWERLINE.left}` : ""}${chipEnd}`;
	const rebandBody = (content: string, targetSurface = surface, targetRgb: Rgb | null = surfaceRgb): string =>
		content.replace(/(?:\x1b\[[0-9;]*m)+/g, (run) => {
			let explicitBg = false;
			let out = "";
			for (const match of run.matchAll(/\x1b\[([0-9;]*)m/g)) {
				const step = reband(match[1] ?? "", explicitBg, targetSurface, targetRgb);
				out += step.out;
				explicitBg = step.explicitBg;
			}
			return out;
		});
	const truecolorSurface = surface.startsWith("\x1b[48;2;");
	const pill = (content: string, tint?: Rgb): string => {
		const tintedRgb = tint && truecolorSurface && surfaceRgb ? pillTintSurface(surfaceRgb, tint) : undefined;
		const pillSurface = tintedRgb ? rgbBg(tintedRgb) : surface;
		const pillCapInk = tintedRgb ? rgbFg(tintedRgb) : capInk;
		const fill = `${pillSurface} ${rebandBody(content, pillSurface, tintedRgb ?? surfaceRgb)}${pillSurface} ${RESET}`;
		return nerd
			? `${pillCapInk}${POWERLINE.roundLeft}${RESET}${fill}${pillCapInk}${POWERLINE.roundRight}${RESET}`
			: fill;
	};
	const band = (content: string, end: "left" | "right"): string => {
		// A group can open with a chip, which sets its own colors and needs no padding.
		let chip = "";
		let rest = content;
		if (content.startsWith("\x1b[48;")) {
			const split = content.indexOf(chipEnd);
			if (split >= 0) {
				chip = content.slice(0, split + chipEnd.length);
				rest = content.slice(chip.length);
			} else {
				// Truncation cut into the chip: keep its colors through the ellipsis and close it.
				// Its arrow takes the column of the padding a chip does not use.
				const open = /^(?:\x1b\[[0-9;]*m)+/.exec(content)![0];
				chip = content.replaceAll(RESET, RESET + open);
				if (chip.endsWith(RESET + open)) chip = chip.slice(0, -open.length);
				chip += closeChip(backgroundRgb(open) ?? INK_DARK);
				rest = "";
			}
		}
		const body = rebandBody(rest);
		const fill = `${chip || `${surface} `}${body}${surface} ${RESET}`;
		if (!nerd) return fill;
		return end === "left"
			? `${fill}${capInk}${POWERLINE.left}${RESET}`
			: `${capInk}${POWERLINE.right}${RESET}${fill}`;
	};
	return {
		chrome: 2 * side + 1,
		...(truecolorSurface && surfaceRgb && { surfaceRgb }),
		bar(left, right, width, center) {
			if (!right) return truncateToWidth(band(truncateToWidth(left, Math.max(0, width - side)), "left"), width);
			const rightWidth = visibleWidth(right);
			if (rightWidth + side >= width) {
				return truncateToWidth(band(truncateToWidth(right, Math.max(0, width - side)), "right"), width);
			}
			const leftStr = truncateToWidth(left, Math.max(0, width - rightWidth - 2 * side - 1));
			const leftBand = visibleWidth(leftStr) > 0 ? band(leftStr, "left") : "";
			const gap = Math.max(1, width - visibleWidth(leftBand) - rightWidth - side);
			// A rule across the gap joins the two bands into one bar; live status floats in a rounded pill
			// tinted lightly by phase so waiting, thinking, writing, and tool calls read at a glance.
			const close = ruleClose || RESET;
			const plainRule = () => (gap >= 3 ? ` ${ruleOpen}${"─".repeat(gap - 2)}${close} ` : " ".repeat(gap));
			let fill: string;
			if (center && typeof center !== "string" && center.pill && visibleWidth(center.text) > 0) {
				const rendered = pill(center.text, center.tint);
				const pw = visibleWidth(rendered);
				if (gap >= pw + 6) {
					const totalRule = gap - pw - 4;
					const leftRule = Math.floor(totalRule / 2);
					const rightRule = totalRule - leftRule;
					fill = ` ${ruleOpen}${"─".repeat(leftRule)}${close} ${rendered} ${ruleOpen}${"─".repeat(rightRule)}${close} `;
				} else if (gap >= pw + 2) {
					const leftPad = Math.floor((gap - pw) / 2);
					const rightPad = gap - pw - leftPad;
					fill = `${" ".repeat(leftPad)}${rendered}${" ".repeat(rightPad)}`;
				} else {
					fill = plainRule();
				}
			} else {
				const rawCenter = typeof center === "string" ? center : center?.text;
				if (rawCenter && visibleWidth(rawCenter) > 0 && gap >= 18) {
					const maxCenter = gap - 8;
					const centerText = truncateToWidth(rawCenter, maxCenter, "…");
					const centerWidth = visibleWidth(centerText);
					const totalRule = gap - centerWidth - 4;
					const leftRule = Math.floor(totalRule / 2);
					const rightRule = totalRule - leftRule;
					fill = ` ${ruleOpen}${"─".repeat(leftRule)}${close} ${centerText} ${ruleOpen}${"─".repeat(rightRule)}${close} `;
				} else {
					fill = plainRule();
				}
			}
			return truncateToWidth(`${leftBand}${fill}${band(right, "right")}`, width);
		},
		// Vendor colors need truecolor; a 256-color bar draws the model as plain text on the band.
		...(truecolorSurface && {
			chip(text: string, color: Rgb) {
				return `${rgbBg(color)}${rgbFg(chipInk(color))}\x1b[1m ${text} ${closeChip(color)}`;
			},
		}),
	};
}

let cachedSkin: { key: string; skin: Skin } | undefined;

/**
 * The powerline skin, or the flat skin where the theme cannot carry a band. Pi gives the
 * footer one theme object for the whole session and swaps the theme behind it, so the skin
 * is cached by the sequences it draws with, never by the object.
 */
function skinFor(theme: Theme): Skin {
	const [surface] = tokenAnsi(text => theme.bg(BAND_TOKEN, text));
	// A terminal-default surface leaves no band to draw.
	if (!surface.startsWith("\x1b[48;")) return FLAT_SKIN;
	const rule = tokenAnsi(text => theme.fg("borderMuted", text));
	const nerd = hasNerdFonts();
	const key = [surface, ...rule, nerd].join("|");
	if (cachedSkin?.key !== key) cachedSkin = { key, skin: powerlineSkin(surface, rule, nerd) };
	return cachedSkin.skin;
}

// ── extension statuses ─────────────────────────────────────────────
// Each extension keeps one identity hue for its icon and leading segment;
// the details stay muted. Hues come from the theme but never sit near its
// error or warning color, so a routine status cannot read as a failure.
// Segments that report a problem or wait on the user use the warning color
// (bold for problems), never red; whole words only, so a status named
// "fix-errors" stays calm. A publisher that styles its own text keeps it.

const STATUS_PROBLEM = /(?:^|[\s:])(?:fail(?:ed|ure|s)?|errors?|stuck|blocked|not_met)(?=$|[\s,.;:)])/i;
const STATUS_ATTENTION = /(?:^|[\s:])(?:paused|awaiting|stopping|killed|for you)(?=$|[\s,.;:)])/i;

export function statusTone(segment: string): "problem" | "attention" | "calm" {
	if (STATUS_PROBLEM.test(segment)) return "problem";
	if (STATUS_ATTENTION.test(segment)) return "attention";
	return "calm";
}

// Placement, compact-summary role, icon, and historical color slot live together.
// Keep slots explicit: moving a status between rows must never change its hue.
type StatusDescriptor = {
	placement: "activity" | "language" | "spokesman" | "mode" | "representative" | "rooms";
	colorSlot?: number;
	icon?: string;
	compact?: "workflow" | "process";
};
const STATUS_DESCRIPTORS: Record<string, StatusDescriptor> = {
	"magpie-quota": { placement: "activity", colorSlot: 12, icon: "\u{F0954}", compact: "workflow" },
	autoresearch: { placement: "activity", colorSlot: 0, icon: "\u{F0093}", compact: "workflow" },
	herder: { placement: "activity", colorSlot: 1, icon: "\u{F0CC6}", compact: "workflow" },
	goal: { placement: "activity", colorSlot: 2, icon: "\u{F0E6F}", compact: "workflow" },
	[PROCESS_STATUS_KEY]: { placement: "activity", colorSlot: 3, icon: "\u{F018D}", compact: "process" },
	subagents: { placement: "activity", colorSlot: 4, icon: "\u{F06A9}" },
	language: { placement: "language", colorSlot: 6, icon: "\u{F05CA}" },
	spokesman: { placement: "spokesman", colorSlot: 7, icon: "\u{F05CB}" },
	swarm: { placement: "mode", colorSlot: 8, icon: "\u{F024B}" },
	selfdrive: { placement: "mode", colorSlot: 10, icon: "\u{F046E}" },
	representative: { placement: "representative", colorSlot: 11, icon: "\u{F01A1}" },
	"relay-rooms": { placement: "rooms" },
};

function statusKeys(placement: StatusDescriptor["placement"]): string[] {
	return Object.keys(STATUS_DESCRIPTORS).filter(key => STATUS_DESCRIPTORS[key]!.placement === placement);
}

function statusText(statuses: ReadonlyMap<string, string>, placement: StatusDescriptor["placement"]): string | undefined {
	return statuses.get(statusKeys(placement)[0]!);
}

/** Joined rooms already named by a plain representative status need no second label. */
function additionalRooms(statuses: ReadonlyMap<string, string>): string | undefined {
	const rooms = statusText(statuses, "rooms");
	const representative = statusText(statuses, "representative");
	if (!rooms || !representative || representative.includes("\x1b[")) return rooms;
	const named = new Set(representative.split(/\s+/));
	return rooms.split(/\s+/).filter(room => !named.has(room)).join(" ") || undefined;
}

/** Rank only the published text; no hidden state or extension-specific parsing. */
function statusRank(text: string): number {
	const tone = statusTone(stripAnsi(text));
	return tone === "problem" ? 3 : tone === "attention" ? 2 : 1;
}

function severityMarker(plain: string, rank = statusRank(plain)): string | undefined {
	if (rank < 2) return undefined;
	return (rank === 3 ? STATUS_PROBLEM : STATUS_ATTENTION).exec(plain)?.[0].replace(/^[\s:]/, "");
}

function activityStatuses(statuses: ReadonlyMap<string, string>): [string, string][] {
	return [
		...statusKeys("activity").flatMap((key): [string, string][] => statuses.get(key) ? [[key, statuses.get(key)!]] : []),
		...[...statuses].filter(([key, text]) => !Object.hasOwn(STATUS_DESCRIPTORS, key) && Boolean(text)),
	];
}
const STATUS_DEFAULT_ICON = "\u{F0431}"; // md-puzzle
const STATUS_HUES: ThemeToken[] = [
	"mdLink", "syntaxVariable", "success", "syntaxType", "syntaxFunction",
	"syntaxString", "mdCode", "thinkingLow", "border", "bashMode",
];

function hue({ r, g, b }: Rgb): number | null {
	const max = Math.max(r, g, b);
	const delta = max - Math.min(r, g, b);
	if (delta < 40) return null; // greys carry no identity
	const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	return (h * 60 + 360) % 360;
}

function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
}

const paletteCache = new WeakMap<Theme, ThemeToken[]>();

/** Distinct theme hues away from red and from the theme's error and warning colors. */
export function statusPalette(theme: Theme): ThemeToken[] {
	const cached = paletteCache.get(theme);
	if (cached) return cached;
	const avoid = (["error", "warning"] as const)
		.map(token => resolveThemeRgb(theme, token))
		.map(rgb => rgb && hue(rgb))
		.filter((h): h is number => h !== null);
	const taken: number[] = [];
	const palette: ThemeToken[] = [];
	for (const token of STATUS_HUES) {
		const rgb = resolveThemeRgb(theme, token);
		// A theme without truecolor cannot be inspected; trust the token's role.
		if (!rgb) { palette.push(token); continue; }
		const h = hue(rgb);
		if (h === null || h >= 330 || h <= 20) continue;
		if (avoid.some(a => hueDistance(a, h) < 35) || taken.some(t => hueDistance(t, h) < 25)) continue;
		taken.push(h);
		palette.push(token);
	}
	if (!palette.length) palette.push("muted");
	paletteCache.set(theme, palette);
	return palette;
}

export function statusHue(theme: Theme, key: string): ThemeToken {
	const palette = statusPalette(theme);
	let slot = STATUS_DESCRIPTORS[key]?.colorSlot;
	if (slot == null) slot = [...key].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) >>> 0, 7);
	return palette[slot % palette.length]!;
}

const STRIP_LEADING_EMOJI_KEYS = new Set(["swarm", "selfdrive", "representative"]);
const LEADING_COLOR_EMOJI = /^(?:🐝|🚗|📣)\s+/u;

function normalizeStatusText(key: string, text: string): string {
	if (text.includes("\x1b[") || !STRIP_LEADING_EMOJI_KEYS.has(key)) return text;
	return text.replace(LEADING_COLOR_EMOJI, "");
}

export function renderStatus(theme: Theme, text: string, key = "", withIcon = false): string {
	if (text.includes("\x1b[")) return text;
	const clean = normalizeStatusText(key, text);
	const identity = statusHue(theme, key);
	// A status that leads with its own symbol needs no second icon.
	const icon = withIcon && /^[\p{L}\p{N}]/u.test(clean)
		? `${theme.fg(identity, STATUS_DESCRIPTORS[key]?.icon ?? STATUS_DEFAULT_ICON)} `
		: "";
	return icon + clean.split(/( · |, )/).map((part, index) => {
		if (index % 2) return theme.fg("dim", part);
		const tone = statusTone(part);
		if (tone === "problem") return theme.fg("warning", theme.bold(part));
		if (tone === "attention") return theme.fg("warning", part);
		return theme.fg(index === 0 ? identity : "muted", part);
	}).join("");
}

/** The language for the bar. A bare name does not say what it is, so it keeps its icon in both modes. */
function renderLanguage(theme: Theme, statuses: ReadonlyMap<string, string>): string | undefined {
	const language = statuses.get("language");
	return language ? renderStatus(theme, language, "language", hasNerdFonts()) : undefined;
}

/** The spokesman model for the bar. Like language, it keeps its icon in both modes. */
function renderSpokesman(theme: Theme, statuses: ReadonlyMap<string, string>): string | undefined {
	const spokesman = statuses.get("spokesman");
	return spokesman ? renderStatus(theme, spokesman, "spokesman", hasNerdFonts()) : undefined;
}

/** Session modes for the bar, using monochrome Nerd Font icons when available. */
function renderModes(theme: Theme, statuses: ReadonlyMap<string, string>, sessionId?: string): string | undefined {
	return cluster(statusKeys("mode").map((key) => {
		const raw = statuses.get(key);
		if (!raw) return undefined;
		const text = key === "swarm" && sessionId && !raw.includes("\x1b[")
			? (summarizeSwarmBoard(sessionId)?.text ?? raw)
			: raw;
		return renderStatus(theme, text, key, hasNerdFonts());
	}), "  ") || undefined;
}

// ── model marks ─────────────────────────────────────────────────────
// A brand glyph before the model name: the vendor logo where Nerd Fonts ship
// one, otherwise a related symbol, tinted with the vendor's color. Model ids
// are matched before providers, so Claude served by Vertex is still Claude.

type ModelBrand = { pattern: RegExp; nerd: string; plain: string; color?: string };

const MODEL_BRANDS: ModelBrand[] = [
	{ pattern: /claude|anthropic|\b(?:opus|sonnet|haiku|fable)\b/, nerd: "\u{EC82}", plain: "✻", color: "#D97757" }, // cod-claude
	{ pattern: /\bgpt|openai|codex|chatgpt|\bo[1-9](?:\b|-)/, nerd: "\u{EC81}", plain: "⊛", color: "#10A37F" }, // cod-openai
	{ pattern: /gemini|gemma|google/, nerd: "\u{F02AD}", plain: "✦", color: "#4285F4" }, // md-google
	{ pattern: /kimi|moonshot/, nerd: "\u{F0F65}", plain: "☾", color: "#7C83FD" }, // md-moon-waning-crescent
	{ pattern: /deepseek/, nerd: "\u{F18B4}", plain: "≋", color: "#4D6BFE" }, // md-dolphin
	{ pattern: /grok|\bx-?ai\b/, nerd: "\u{F0B05}", plain: "⨯" }, // md-alpha-x
	{ pattern: /llama|\bmeta\b/, nerd: "\u{F06E4}", plain: "∞", color: "#0866FF" }, // md-infinity
	{ pattern: /mistral|codestral|devstral|magistral|ministral|pixtral/, nerd: "\u{F059D}", plain: "▚", color: "#FF8205" }, // md-weather-windy
	{ pattern: /qwen|qwq/, nerd: "\u{F02D8}", plain: "⬡", color: "#615CED" }, // md-hexagon
];

export function modelBrand(id: string, provider = ""): ModelBrand | undefined {
	const lowerId = id.toLowerCase();
	const lowerProvider = provider.toLowerCase();
	return MODEL_BRANDS.find(brand => brand.pattern.test(lowerId))
		?? MODEL_BRANDS.find(brand => brand.pattern.test(lowerProvider));
}

export function renderModelMark(theme: Theme, id: string, provider?: string): string {
	const brand = modelBrand(id, provider);
	if (!brand) return "";
	const glyph = theme.bold(hasNerdFonts() ? brand.nerd : brand.plain);
	return `${brand.color ? hexFg(brand.color, glyph) : theme.fg("text", glyph)} `;
}

// ── session stats ───────────────────────────────────────────────────
//
// Walking the full branch is O(session size), so results are cached
// keyed by the branch's leaf entry id: the leaf changes exactly when a
// new entry is appended (or on fork/tree-nav/compaction), which means
// renders during streaming — the hot path — always hit the cache.
// Only durationMs is recomputed per render (Date.now() moves).

type MagpiePricing = "estimate" | "unavailable";
type PricedUsage = Usage & { cost: Usage["cost"] & { magpiePricing?: MagpiePricing } };

interface Stats {
	input: number;
	output: number;
	cost: number;
	subagentCost: number;
	priceUnavailable: boolean;
	priceEstimated: boolean;
	magpieFastEnabled: boolean;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	turns: number;
	compactions: number;
	errors: number;
	toolCalls: number;
	files: number;
	/** Pika relay messages received and sent, from its `relay-received` and `relay-sent` entries. */
	relayIn: number;
	relayOut: number;
	/** Estimated context tokens of Pika memory: its pinned section and memory tool results still in context. */
	memoryTokens: number;
	durationMs: number;
}

/** Pika memory's pinned index entry; `index` is null when the session has no memory section. */
const MEMORY_PIN_ENTRY = "pika-memory";
const MEMORY_TOOLS = new Set(["memory_read", "memory_save", "memory_forget"]);
/**
 * Characters Pika's memory section adds around its index: the 425-character preamble of Pika's
 * `sectionText` and the 19 of Pi's `<memory>\n` … `\n</memory>` wrapping. It mirrors Pika's text, so
 * the section size is an estimate; the escaping of `<` and `>` in the index is not counted.
 */
const MEMORY_SECTION_OVERHEAD = 444;

function addUsage(stats: Stats, usage: Usage | undefined, provider?: string): void {
	if (!usage) return;
	stats.input += usage.input;
	stats.output += usage.output;
	stats.cacheRead += usage.cacheRead;
	stats.cacheWrite += usage.cacheWrite ?? 0;
	stats.reasoning += usage.reasoning ?? 0;
	const marker = (usage as PricedUsage).cost.magpiePricing;
	const hasTokens = Boolean(usage.input || usage.output || usage.cacheRead || usage.cacheWrite);
	if ((marker === "unavailable" || (provider === "magpie" && marker === undefined && usage.cost.total === 0)) && hasTokens) {
		stats.priceUnavailable = true;
	} else {
		stats.cost += usage.cost.total;
		if (marker === "estimate" || (provider === "magpie" && marker === undefined && usage.cost.total > 0)) {
			stats.priceEstimated = true;
		}
	}
}

interface StatsCache {
	leafId: string | null;
	firstTs: number | undefined;
	stats: Stats;
}

type LivePhase = "idle" | "waiting" | "thinking" | "streaming" | "tool";

const MUTATING_TOOLS = new Set(["edit", "write", "bash"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

interface SessionState {
	statsCache?: StatsCache;
	metrics: StreamMetrics;
	cacheLens: CacheLensTracker;
	gitStat: GitStat;
	gitStatAt: number;
	gitStatCwd: string;
	serviceTier?: string;
	livePhase: LivePhase;
	phaseStartedAt: number;
	activeToolName?: string;
	activeToolCallId?: string;
	lastContextTokens?: number;
	lastContextDelta?: number;
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
		subagentCost: 0,
		priceUnavailable: false,
		priceEstimated: false,
		magpieFastEnabled: false,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		turns: 0,
		compactions: 0,
		errors: 0,
		toolCalls: 0,
		files: 0,
		relayIn: 0,
		relayOut: 0,
		memoryTokens: 0,
		durationMs: 0,
	};
	const files = new Set<string>();
	let firstTs: number | undefined;
	let memorySectionChars = 0;
	/** Memory tool results by branch position; the latest compaction drops those before its first kept entry, as Pi does. */
	const memoryResults: { at: number; chars: number }[] = [];
	let memoryKeptFrom = 0;

	const branch = ctx.sessionManager.getBranch();
	for (const [at, e] of branch.entries()) {
		if (e.type === "custom" && e.customType === MEMORY_PIN_ENTRY) {
			const index = (e.data as { index?: unknown } | undefined)?.index;
			memorySectionChars = typeof index === "string" ? index.length + MEMORY_SECTION_OVERHEAD : 0;
			continue;
		}
		if (e.type === "custom" && e.customType === "magpie-fast") {
			const enabled = (e.data as { enabled?: unknown } | undefined)?.enabled;
			if (typeof enabled === "boolean") s.magpieFastEnabled = enabled;
			continue;
		}
		if (e.type === "custom" && e.customType === "magpie-pricing") {
			const pricing = (e.data as { pricing?: unknown } | undefined)?.pricing;
			if (pricing === "unavailable") s.priceUnavailable = true;
			if (pricing === "estimate") s.priceEstimated = true;
			continue;
		}
		if (e.type === "custom" && e.customType === "relay-received") {
			s.relayIn++;
			continue;
		}
		if (e.type === "custom" && e.customType === "relay-sent") {
			s.relayOut++;
			continue;
		}
		if (e.type === "custom" && e.customType === "spokesman-rewrite") {
			const data = e.data as { usage?: Usage; provider?: string } | undefined;
			if (data?.usage) addUsage(s, data.usage, data.provider ?? (data as { spokesmanProvider?: string })?.spokesmanProvider);
			continue;
		}
		if (e.type === "compaction") {
			s.compactions++;
			addUsage(s, e.usage);
			// A first kept entry missing before the compaction keeps nothing from before it.
			const kept = branch.findIndex((entry, i) => i < at && entry.id === e.firstKeptEntryId);
			memoryKeptFrom = kept >= 0 ? kept : at;
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
			addUsage(s, m.usage, m.provider);
			for (const block of m.content ?? []) {
				if (block.type !== "toolCall") continue;
				s.toolCalls++;
				const args = block.arguments as Record<string, unknown>;
				if (typeof block.name === "string" && EDIT_TOOLS.has(block.name.toLowerCase()) && typeof args.path === "string") {
					files.add(args.path);
				}
			}
		} else if (m.role === "toolResult") {
			addUsage(s, m.usage);
			const toolCost = m.usage?.cost?.total;
			if (typeof toolCost === "number" && Number.isFinite(toolCost) && toolCost > 0) {
				s.subagentCost += toolCost;
			}
			if (m.isError) s.errors++;
			if (MEMORY_TOOLS.has(m.toolName)) {
				let chars = 0;
				for (const block of m.content ?? []) if (block.type === "text") chars += block.text.length;
				memoryResults.push({ at, chars });
			}
		}
	}

	s.files = files.size;
	const memoryChars = memoryResults.reduce((sum, result) => sum + (result.at >= memoryKeptFrom ? result.chars : 0), memorySectionChars);
	// Pi's estimate: four characters per token.
	s.memoryTokens = Math.ceil(memoryChars / 4);
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
//   message_end (assistant)  → exact usage.output + call end time
//
// Avg tok/s = Σ output tokens / Σ call durations, each from the request to
// the last token, over completed requests with observed content in this
// session. The time after the first token is not used: many responses
// arrive in one burst once the model has finished, and hidden reasoning
// counts in output without streaming, so it read as thousands of tok/s.

interface StreamMetrics {
	requestSentAt: number;
	firstTokenAt: number;
	curTtftMs: number | null; // TTFT of the in-flight request, if measured
	lastTtftMs: number | null;
	lastTtfbMs: number | null; // response-headers time, when the provider exposes it
	lastTokPerSec: number | null;
	totalOutput: number;
	totalCallMs: number;
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
		totalCallMs: 0,
		totalTtftMs: 0,
		ttftCount: 0,
		requests: 0,
		headersSeen: 0,
		responsesSeen: 0,
	};
}

function avgTokPerSec(metrics: StreamMetrics): number | null {
	if (metrics.totalCallMs <= 0 || metrics.totalOutput <= 0) return null;
	return metrics.totalOutput / (metrics.totalCallMs / 1000);
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
	adds?: number;
	dels?: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
	worktree: boolean;
	ahead: number;
	behind: number;
}

function pendingGitStat(): GitStat {
	return {
		status: "pending",
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicts: 0,
		worktree: false,
		ahead: 0,
		behind: 0,
	};
}

// Keep telemetry keyed by session so child lifecycle and stream events cannot
// reset or corrupt the interactive parent's footer. Actual reloads replace this
// module; only the small custom-entry snapshot survives them.
const sessionStates = new Map<string, SessionState>();
const RELOAD_ENTRY = "statusline-footer:reload";
type ReloadSnapshot = Pick<SessionState, "metrics" | "serviceTier"> & {
	cacheLens?: CacheLensReloadSnapshot;
	mode?: FooterMode;
};

function restoreSnapshot(data: unknown): ReloadSnapshot | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const { metrics, serviceTier, cacheLens, mode: savedMode } = data as Record<string, unknown>;
	if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return undefined;
	if (serviceTier !== undefined && typeof serviceTier !== "string") return undefined;
	if (savedMode !== undefined && savedMode !== "full" && savedMode !== "compact" && savedMode !== "off") {
		return undefined;
	}

	let parsedCacheLens: CacheLensReloadSnapshot | undefined;
	if (cacheLens !== undefined) {
		const parsed = parseCacheLensReloadSnapshot(cacheLens);
		if (!parsed) return undefined;
		parsedCacheLens = parsed;
	}

	const restored = freshMetrics();
	for (const key of Object.keys(restored) as (keyof StreamMetrics)[]) {
		const value = (metrics as Record<string, unknown>)[key];
		if (value === null && restored[key] === null) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
		restored[key] = value;
	}
	restored.requestSentAt = 0;
	restored.firstTokenAt = 0;
	restored.curTtftMs = null;
	return { metrics: restored, serviceTier, cacheLens: parsedCacheLens, mode: savedMode };
}

function freshSessionState(previous?: ReloadSnapshot): SessionState {
	const cacheLens = new CacheLensTracker();
	if (previous?.cacheLens) cacheLens.restoreReloadSnapshot(previous.cacheLens);
	return {
		metrics: previous?.metrics ?? freshMetrics(),
		cacheLens,
		gitStat: pendingGitStat(),
		gitStatAt: 0,
		gitStatCwd: "",
		serviceTier: previous?.serviceTier,
		livePhase: "idle",
		phaseStartedAt: 0,
	};
}

function getSessionState(ctx: ExtensionContext): SessionState | undefined {
	return sessionStates.get(ctx.sessionManager.getSessionId());
}

export function parseGitShortstat(stdout: string): Pick<GitStat, "adds" | "dels"> {
	const adds = /(\d+) insertions?\(\+\)/.exec(stdout);
	const dels = /(\d+) deletions?\(-\)/.exec(stdout);
	return {
		adds: adds ? Number(adds[1]) : 0,
		dels: dels ? Number(dels[1]) : 0,
	};
}

export function parseGitPorcelain(stdout: string): {
	status: "clean" | "dirty";
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
} {
	const lines = stdout.split(/\r?\n/).filter(line => line.length > 0);
	if (lines.length === 0) {
		return { status: "clean", staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
	}
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let conflicts = 0;
	for (const line of lines) {
		if (line.length < 2) continue;
		const x = line[0]!;
		const y = line[1]!;
		const xy = x + y;
		if (xy === "??") {
			untracked++;
		} else if (xy === "DD" || xy === "AU" || xy === "UD" || xy === "UA" || xy === "DU" || xy === "AA" || xy === "UU") {
			conflicts++;
		} else {
			if (x !== " " && x !== "?" && x !== "!") staged++;
			if (y !== " " && y !== "?" && y !== "!") unstaged++;
		}
	}
	return { status: "dirty", staged, unstaged, untracked, conflicts };
}

export function parseGitStatus(stdout: string): "clean" | "dirty" {
	return parseGitPorcelain(stdout).status;
}

export function detectLinkedWorktree(cwd: string): boolean {
	let dir = path.resolve(cwd);
	while (true) {
		const dotGit = path.join(dir, ".git");
		try {
			const stat = fs.statSync(dotGit);
			if (stat.isDirectory()) return false;
			if (stat.isFile()) {
				const content = fs.readFileSync(dotGit, "utf8");
				return /^gitdir:\s*.*[\\/]worktrees[\\/]/i.test(content.trim());
			}
		} catch {
			// Not present here; keep walking upward.
		}
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

/** `git rev-list --left-right --count @{upstream}...HEAD` → behind then ahead. */
export function parseGitAheadBehind(stdout: string): { ahead: number; behind: number } {
	const match = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim());
	if (!match) return { ahead: 0, behind: 0 };
	return { behind: Number(match[1]), ahead: Number(match[2]) };
}

export function extractServiceTier(payload: unknown, api?: string): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	const raw = record.service_tier ?? record.serviceTier;
	const tier = typeof raw === "string" ? raw.trim() || undefined : undefined;
	// Messages requests can specify fast inference and a capacity tier independently.
	if (api === "anthropic-messages" && record.speed === "fast") {
		return displayServiceTier(tier, api) ? `fast · ${tier}` : "fast";
	}
	return tier;
}

const STANDARD_TIERS = new Set(["standard", "default", "auto"]);

export function displayServiceTier(tier: string | undefined, api?: string): string | undefined {
	const normalized = tier?.trim().toLowerCase();
	if (!normalized || STANDARD_TIERS.has(normalized)) return undefined;
	if (normalized === "standard_only" && api !== "anthropic-messages") return undefined;
	return normalized.toUpperCase();
}

function refreshGitStat(cwd: string, state: SessionState) {
	const now = Date.now();
	if (state.gitStatCwd === cwd && now - state.gitStatAt < 15_000) return;
	state.gitStatAt = now;
	// The last value for this cwd stays painted until the new one arrives.
	if (state.gitStatCwd !== cwd) state.gitStat = pendingGitStat();
	state.gitStatCwd = cwd;
	const opts = { cwd, timeout: 5000 };
	const worktree = detectLinkedWorktree(cwd);
	let porcelain: ReturnType<typeof parseGitPorcelain> | undefined;
	let shortstat: Pick<GitStat, "adds" | "dels"> | undefined;
	let aheadBehind = { ahead: 0, behind: 0 };
	let pending = 3;
	const finish = () => {
		pending -= 1;
		if (pending > 0) return;
		state.gitStat = {
			status: porcelain ? porcelain.status : "unavailable",
			staged: porcelain?.staged ?? 0,
			unstaged: porcelain?.unstaged ?? 0,
			untracked: porcelain?.untracked ?? 0,
			conflicts: porcelain?.conflicts ?? 0,
			worktree,
			...(shortstat ?? {}),
			...aheadBehind,
		};
		state.requestRender?.();
	};
	execFile("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"], opts, (err, stdout) => {
		porcelain = err ? undefined : parseGitPorcelain(stdout);
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
// Nerd Fonts are assumed; STATUSLINE_NERD_FONTS=0 (or FOOTER_NERD_FONTS=0)
// selects the ASCII/Unicode set for a terminal without them.

type IconSet = {
	thinking: string;
	tier: string;
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
	relay: string;
	file: string;
	edit: string;
	cwd: string;
};

const NERD_ICONS: IconSet = {
	thinking: "\u{F09D1}", // md-brain
	tier: "\u{F0241}", // md-flash
	compact: "\u{F0615}", // md-arrow-collapse
	elapsed: "\u{F0954}", // md-clock
	turns: "\u{F0368}", // md-message-reply-text
	input: "\u{F005E}", // md-arrow-up-thick
	output: "\u{F0046}", // md-arrow-down-thick
	cache: "\u{F140B}", // md-lightning-bolt
	cost: "\u{F01C1}", // md-currency-usd
	ttft: "\u{F051B}", // md-timer-outline
	ttfb: "\u{F048D}", // md-server-network
	speed: "\u{F04C5}", // md-speedometer
	last: "\u{F02DA}", // md-history
	calls: "\u{F05B7}", // md-wrench
	err: "\u{F0159}", // md-close-circle
	ok: "\u{F0133}", // md-checkbox-marked-circle
	branch: "\u{F062C}", // md-source-branch
	relay: "\u{F028C}", // md-forum
	file: "\u{F0224}", // md-file-outline
	edit: "\u{F03EB}", // md-pencil
	cwd: "\u{F0770}", // md-folder-open
};

const ASCII_ICONS: IconSet = {
	thinking: "∴",
	tier: "ϟ",
	compact: "×",
	elapsed: "◷",
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
	relay: "⇌",
	file: "▤",
	edit: "✎",
	cwd: "⌂",
};

export function hasNerdFonts(): boolean {
	return (process.env.STATUSLINE_NERD_FONTS ?? process.env.FOOTER_NERD_FONTS) !== "0";
}

function icons(): IconSet {
	return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

function glyph(theme: Theme, icon: string, color?: ThemeToken): string {
	return color ? theme.fg(color, theme.bold(icon)) : theme.bold(icon);
}

// ── rendering ───────────────────────────────────────────────────────

function thinkingCaps(level: string): string {
	return level.toUpperCase();
}

export function renderThinking(theme: Theme, level: string): string {
	const text = thinkingCaps(level);
	if (level === "max") return rainbow(text);
	if (level === "xhigh") return theme.fg("text", text);
	if (level === "high") {
		return resolveThemeRgb(theme, "thinkingHigh")
			? theme.fg("thinkingHigh", text)
			: theme.fg("accent", text);
	}
	if (level === "medium") return theme.fg("success", text);
	if (level === "low") return theme.fg("warning", text);
	if (level === "off") return theme.fg("dim", text);
	return theme.fg("muted", text);
}

interface TierLabel {
	text: string;
	active: boolean;
	observed?: string;
}

/** Prefer the current Magpie switch to the last request's tier. */
function tierLabel(ctx: ExtensionContext, stats: Stats, observedTier?: string): TierLabel | undefined {
	const selected = ctx.model;
	const observed = displayServiceTier(observedTier, selected?.api);
	if (selected?.provider === "magpie" && selected.api === "openai-responses") {
		const current = ctx.modelRegistry.getAll().find(model => model.provider === selected.provider && model.id === selected.id) as
			(typeof selected & { magpieServiceTiers?: string[] }) | undefined;
		if (current && current.api === selected.api && current.magpieServiceTiers?.includes("priority")) {
			return {
				text: stats.magpieFastEnabled ? "ON" : "OFF",
				active: stats.magpieFastEnabled,
				observed: observed === "PRIORITY" ? undefined : observed,
			};
		}
		// A stale request must not advertise Fast after the catalog removes support.
		if (observed === "PRIORITY") return undefined;
	}
	return observed ? { text: observed, active: true } : undefined;
}

function renderModelLabel(
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	tier?: TierLabel,
	suppressLiveBadge = false,
): string {
	const model = ctx.model;
	const live = !suppressLiveBadge && !ctx.isIdle();
	const queuedMark = !suppressLiveBadge && ctx.hasPendingMessages() && theme.fg("warning", "queued");
	const tierMark = tier && cluster([
		theme.fg(tier.active ? "warning" : "dim", theme.bold(`${icons().tier} ${tier.text}`)),
		tier.observed && theme.fg("warning", theme.bold(`last ${tier.observed}`)),
	], "  ");
	const brand = model && modelBrand(model.id, model.provider);
	// A chip carries the live dot and the vendor mark in its own ink.
	const chipColor = skin.chip && ((brand?.color && hexToRgb(brand.color)) || resolveThemeRgb(theme, "accent"));
	if (skin.chip && chipColor) {
		const mark = brand ? `${hasNerdFonts() ? brand.nerd : brand.plain} ` : "";
		return cluster([
			skin.chip(`${live ? "● " : ""}${mark}${model?.id ?? "no-model"}`, chipColor),
			tierMark,
			queuedMark,
		], "  ");
	}
	const liveMark = live && theme.fg("success", theme.bold("●"));
	const name = model
		? renderModelMark(theme, model.id, model.provider) + theme.fg("accent", theme.bold(model.id))
		: theme.fg("accent", theme.bold("no-model"));
	return cluster([liveMark, queuedMark, name, tierMark], "  ");
}

const WAIT_FRAMES = ["◌", "◔", "◑", "◕"] as const;
const THINK_FRAMES = ["✧", "✦", "✶", "✦"] as const;

function toolPhaseIcon(toolName: string): string {
	const name = toolName.toLowerCase();
	const nerd = hasNerdFonts();
	if (name === "bash" || name.includes("shell") || name.includes("exec")) return nerd ? "\u{F018D}" : "❯";
	if (name === "read" || name.endsWith("_read")) return icons().file;
	if (name === "edit" || name === "write") return "✎";
	if (name.includes("grep") || name.includes("find") || name.includes("search")) return "⌕";
	if (name === "agent" || name.includes("subagent")) return nerd ? "\u{F06A9}" : "◈";
	if (name.includes("browser") || name.includes("desktop") || name.includes("fetch")) return "◎";
	return icons().calls;
}

function renderLivePhase(ctx: ExtensionContext, theme: Theme, state: SessionState): { text: string; tint?: Rgb } {
	const tintFor = (token: ThemeToken): Rgb | undefined => resolveThemeRgb(theme, token) ?? undefined;
	if (ctx.isIdle()) {
		if (ctx.hasPendingMessages()) {
			return {
				text: `${glyph(theme, "◔", "warning")} ${theme.fg("warning", "queued")}`,
				tint: tintFor("warning"),
			};
		}
		return { text: `${glyph(theme, "◦", "success")} ${theme.fg("muted", "ready")}` };
	}
	const elapsedMs = state.phaseStartedAt > 0 ? Math.max(0, Date.now() - state.phaseStartedAt) : 0;
	const tick = Math.floor(elapsedMs / 1_000);
	const elapsed = elapsedMs >= 1_000 ? ` ${theme.fg("muted", fmtPhaseElapsed(elapsedMs))}` : "";
	const queuedSuffix = ctx.hasPendingMessages()
		? `${theme.fg("dim", " · ")}${theme.fg("warning", "queued")}`
		: "";
	switch (state.livePhase) {
		case "waiting": {
			const icon = WAIT_FRAMES[tick % WAIT_FRAMES.length]!;
			return {
				text: `${glyph(theme, icon, "warning")} ${theme.fg("warning", "waiting")}${elapsed}${queuedSuffix}`,
				tint: tintFor("warning"),
			};
		}
		case "thinking": {
			const icon = THINK_FRAMES[tick % THINK_FRAMES.length]!;
			const tone: ThemeToken = resolveThemeRgb(theme, "thinkingHigh") ? "thinkingHigh" : "accent";
			return {
				text: `${glyph(theme, icon, tone)} ${theme.fg(tone, "thinking")}${elapsed}${queuedSuffix}`,
				tint: tintFor(tone),
			};
		}
		case "streaming":
			return {
				text: `${glyph(theme, "✎", "success")} ${theme.fg("success", "writing")}${elapsed}${queuedSuffix}`,
				tint: tintFor("success"),
			};
		case "tool": {
			const rawName = state.activeToolName ?? "tool";
			const toolName = truncateToWidth(rawName, 14, "…");
			// Use sky-blue (syntaxVariable / mdLink) so tools stay distinct from amber waiting.
			const tone: ThemeToken = resolveThemeRgb(theme, "syntaxVariable")
				? "syntaxVariable"
				: resolveThemeRgb(theme, "mdLink")
					? "mdLink"
					: "syntaxFunction";
			return {
				text: `${glyph(theme, toolPhaseIcon(rawName), tone)} ${theme.fg(tone, toolName)}${elapsed}${queuedSuffix}`,
				tint: tintFor(tone),
			};
		}
		case "idle": {
			const icon = WAIT_FRAMES[tick % WAIT_FRAMES.length]!;
			const tone: ThemeToken = resolveThemeRgb(theme, "mdLink") ? "mdLink" : "accent";
			return {
				text: `${glyph(theme, icon, tone)} ${theme.fg(tone, "working")}${elapsed}${queuedSuffix}`,
				tint: tintFor(tone),
			};
		}
	}
}

/**
 * Embeds the session title on the right end of an editor's top border line,
 * mirroring how Pi embeds "Working..." on the top-left border (`── title ──`).
 */
export function embedRightBorderTitle(
	base: string,
	width: number,
	rawTitle: string | undefined,
	borderColor: (text: string) => string,
	titleColor: (text: string) => string = borderColor,
): string {
	if (!rawTitle || width <= 0) return base;
	const title = rawTitle.replace(/\s+/g, " ").trim();
	if (!title) return base;
	const plain = stripAnsi(base);
	const baseWidth = visibleWidth(base);
	let trailingDashes = 0;
	for (let i = plain.length - 1; i >= 0 && plain[i] === "─"; i--) trailingDashes++;
	// Keep at least 2 dashes between any left/center border label and " <title> ──".
	const available = trailingDashes - 6;
	if (available < 4) return base;
	const maxTitle = Math.min(available, Math.max(12, Math.floor(width * 0.45)));
	const fitted = truncateToWidth(title, maxTitle, "…");
	const fittedWidth = visibleWidth(fitted);
	if (fittedWidth === 0 || fittedWidth + 6 > trailingDashes || baseWidth < fittedWidth + 4) return base;
	const prefix = truncateToWidth(base, baseWidth - (fittedWidth + 4), "");
	return `${prefix}${borderColor(" ")}${titleColor(fitted)}${borderColor(" ──")}`;
}

export function isGenericWorkingStatus(rendered: string): boolean {
	const text = stripAnsi(rendered).trim().replace(/^[^\p{L}\p{N}]+\s*/u, "");
	return /^working(?:\.{3}|…)?(?:\s*\([^)]*\))?$/i.test(text);
}

const EDITOR_BOTTOM_SENTINEL = "\u0000statusline-footer:editor-bottom\u0000";

class TitledEditor extends CustomEditor {
	private readonly getTitle: () => string | undefined;
	private readonly getTheme: () => Theme | undefined;
	private activeIndicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
	private inRender = false;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		getTitle: () => string | undefined,
		getTheme: () => Theme | undefined,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
		this.getTitle = getTitle;
		this.getTheme = getTheme;
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		this.activeIndicator = indicator;
		super.setWorkingStatusIndicator(indicator);
	}

	private shouldSuppressIndicator(width: number): boolean {
		const indicator = this.activeIndicator;
		if (!indicator) return false;
		// Hide Pi's generic "Working" indicator (covered by the footer's centered state pill),
		// while keeping compaction, retry, branch summary, and custom setWorkingMessage() notices visible.
		const meta = indicator as unknown as { kind?: unknown; message?: unknown };
		if (meta.kind !== undefined && meta.kind !== "working") return false;
		if (typeof meta.message === "string") return isGenericWorkingStatus(meta.message);
		return isGenericWorkingStatus(indicator.renderInBorder(Math.max(64, width)));
	}

	private isBashMode(theme: Theme | undefined): boolean {
		if (!theme || typeof theme.fg !== "function") return false;
		const bashSample = theme.fg("bashMode", "─");
		const mutedSample = theme.fg("borderMuted", "─");
		return bashSample !== mutedSample && this.borderColor("─") === bashSample;
	}

	private ruleColor(theme: Theme | undefined): (text: string) => string {
		if (!theme || typeof theme.fg !== "function" || this.isBashMode(theme)) {
			const current = this.borderColor;
			return (text) => current(text);
		}
		return (text) => theme.fg("borderMuted", text);
	}

	private titleColor(theme: Theme | undefined): (text: string) => string {
		if (!theme || typeof theme.fg !== "function") {
			const current = this.borderColor;
			return (text) => current(text);
		}
		return (text) => theme.fg("muted", text);
	}

	private withRuleColor<T>(rule: (text: string) => string, fn: () => T): T {
		const saved = this.borderColor;
		this.borderColor = rule;
		try {
			return fn();
		} finally {
			this.borderColor = saved;
		}
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const theme = this.getTheme();
		const rule = this.ruleColor(theme);
		const title = this.titleColor(theme);
		const suppress = this.shouldSuppressIndicator(width);
		const base = this.withRuleColor(rule, () => {
			if (!suppress) return super.renderTopBorder(width, hiddenLineCount);
			super.setWorkingStatusIndicator(undefined);
			try {
				return super.renderTopBorder(width, hiddenLineCount);
			} finally {
				super.setWorkingStatusIndicator(this.activeIndicator);
			}
		});
		return embedRightBorderTitle(base, width, this.getTitle(), rule, title);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (this.inRender && hiddenLineCount === 0 && footerTier(width) !== "phone") {
			return EDITOR_BOTTOM_SENTINEL;
		}
		const rule = this.ruleColor(this.getTheme());
		return this.withRuleColor(rule, () => super.renderBottomBorder(width, hiddenLineCount));
	}

	override render(width: number): string[] {
		this.inRender = true;
		let lines: string[];
		try {
			lines = super.render(width);
		} finally {
			this.inRender = false;
		}
		const bottomIdx = lines.indexOf(EDITOR_BOTTOM_SENTINEL);
		if (bottomIdx < 0) return lines;
		// Keep a separator line when an autocomplete menu sits below the input; otherwise let the
		// footer's Powerline identity bar serve as the input box's bottom edge (avoiding a double rule).
		if (bottomIdx + 1 < lines.length) {
			const rule = this.ruleColor(this.getTheme());
			lines[bottomIdx] = this.withRuleColor(rule, () => super.renderBottomBorder(width, 0));
			return lines;
		}
		lines.splice(bottomIdx, 1);
		return lines;
	}
}

interface RenderContextOptions {
	thresholdPct?: number;
	surfaceRgb?: Rgb;
	contextDelta?: number;
}

function renderContext(
	theme: Theme,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
	barWidth: number,
	compactions: number,
	compactIcon: string,
	maxWidth = Infinity,
	options?: RenderContextOptions,
): string {
	const count = compactions > 0 ? theme.fg("warning", `${compactions}×`) : "";
	const compact = compactions > 0 ? `${glyph(theme, compactIcon, "warning")} ${count}` : "";
	const barOpts: GradientBarOptions = {
		thresholdPct: options?.thresholdPct,
		surfaceRgb: options?.surfaceRgb,
	};
	if (usage?.percent != null) {
		const pct = usage.percent;
		const used = fmtTokens(usage.tokens ?? 0);
		const window = fmtTokens(usage.contextWindow);
		const percent = theme.fg("muted", `${pct.toFixed(1)}%`);
		const counts = theme.fg("dim", `${used}/${window}`);
		const delta = options?.contextDelta != null && options.contextDelta >= 5_000
			? theme.fg(options.contextDelta >= 20_000 ? "warning" : "dim", `+${fmtTokens(options.contextDelta)}`)
			: "";
		if (delta) {
			const countsWithDelta = `${counts} ${delta}`;
			const numbersWithDelta = cluster([compact, percent, countsWithDelta], "  ");
			const barSpaceWithDelta = maxWidth - visibleWidth(numbersWithDelta) - 2;
			if (barSpaceWithDelta >= 4) {
				return cluster([compact, gradientBar(pct, Math.min(barWidth, barSpaceWithDelta), theme, barOpts), percent, countsWithDelta], "  ");
			}
		}
		const numbers = cluster([compact, percent, counts], "  ");
		const barSpace = maxWidth - visibleWidth(numbers) - 2;
		if (barSpace >= 4) {
			return cluster([compact, gradientBar(pct, Math.min(barWidth, barSpace), theme, barOpts), percent, counts], "  ");
		}
		// Keep the numerical context when it fits without a bar.
		if (visibleWidth(numbers) <= maxWidth) return numbers;
		// The bare compaction count and a single usage group can still fit before token counts give way.
		const shortNumbers = cluster([count, `${percent} ${counts}`], "  ");
		if (visibleWidth(shortNumbers) <= maxWidth) return shortNumbers;
		const remaining = maxWidth - visibleWidth(cluster([compact, percent], "  ")) - 2;
		return remaining >= 4
			? cluster([compact, gradientBar(pct, Math.min(barWidth, remaining), theme, barOpts), percent], "  ")
			: truncateToWidth(percent, Math.max(0, maxWidth));
	}
	if (usage?.contextWindow) {
		return truncateToWidth(cluster([compact, theme.fg("dim", `/ ${fmtTokens(usage.contextWindow)}`)], "  "), maxWidth);
	}
	return compact ? truncateToWidth(compact, maxWidth) : "";
}

function priceUnavailableForModel(ctx: ExtensionContext): boolean {
	const model = ctx.model as (NonNullable<ExtensionContext["model"]> & { magpiePricing?: MagpiePricing }) | undefined;
	if (model?.provider !== "magpie") return false;
	if (model.magpiePricing === "unavailable") return true;
	if (model.magpiePricing === "estimate") return false;
	return model.cost.input === 0 && model.cost.output === 0
		&& model.cost.cacheRead === 0 && model.cost.cacheWrite === 0;
}

function renderPrice(ctx: ExtensionContext, s: Stats, theme: Theme, set: IconSet): string {
	const unavailable = s.priceUnavailable || priceUnavailableForModel(ctx);
	const amount = unavailable ? "price unavailable" : `${s.priceEstimated ? "~" : ""}${fmtCost(s.cost)}`;
	// The ASCII cost icon is itself a dollar sign; the amount already contains one.
	const icon = hasNerdFonts() ? `${glyph(theme, set.cost, "warning")} ` : "";
	return theme.fg("warning", `${icon}${amount}`);
}

interface CompactStatus {
	text: string;
	shortText?: string;
	fallbackText?: string;
	abbreviate?: boolean;
	abbreviateAbove?: number;
	severityMarker?: string;
	rank: number;
}

/** Fit higher-priority statuses first, then restore their details when space permits. */
function fitCompactStatuses(statuses: CompactStatus[], fits: (text: string) => boolean): string {
	const selected = new Map<CompactStatus, string>();
	const ordered = [...statuses].sort((a, b) => b.rank - a.rank);
	const summary = () => cluster(statuses.map(status => selected.get(status)), "  ");
	for (const status of ordered) {
		selected.set(status, status.shortText ?? status.text);
		if (!fits(summary()) && status.abbreviate && visibleWidth(status.shortText ?? status.text) > (status.abbreviateAbove ?? 24)) {
			const source = status.shortText ?? status.text;
			const suffix = status.severityMarker ? ` ${status.severityMarker}` : "";
			for (let width = visibleWidth(source) - 1; width >= 16; width--) {
				selected.set(status, truncateToWidth(source, width, "…") + suffix);
				if (fits(summary())) break;
			}
		}
		if (!fits(summary()) && status.fallbackText) selected.set(status, status.fallbackText);
		if (!fits(summary())) selected.delete(status);
	}
	for (const status of ordered) {
		const previous = selected.get(status);
		if (!previous) continue;
		for (const candidate of [status.text, status.shortText]) {
			if (!candidate) continue;
			selected.set(status, candidate);
			if (fits(summary())) break;
			selected.set(status, previous);
		}
	}
	return summary();
}

function renderIdentityRow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	width: number,
	state: SessionState,
	s: Stats,
	compactMode: boolean,
	languageStatus?: string,
	workflowStatus?: string | CompactStatus[],
	spokesmanStatus?: string,
	modeStatus?: string,
	collaborationStatus?: string,
): string {
	const set = icons();
	const { chrome } = skin;
	const usage = ctx.getContextUsage();
	const barWidth = compactMode ? COMPACT_BAR_WIDTH : BAR_WIDTH;
	const minimumContext = usage?.percent != null ? visibleWidth(`${usage.percent.toFixed(1)}%`) : 0;
	const identityRoom = width - minimumContext - chrome;
	const tier = tierLabel(ctx, s, state.serviceTier);
	const provider = !compactMode && ctx.model?.provider && theme.fg("dim", `(${ctx.model.provider})`);
	const contextOptions: RenderContextOptions = {
		thresholdPct: compactionThresholdPct(pi, ctx),
		surfaceRgb: skin.surfaceRgb,
		contextDelta: !compactMode && footerTier(width) === "desk" ? state.lastContextDelta : undefined,
	};
	const buildIdentity = (suppressLiveBadge: boolean): string => {
		const label = (serviceTier?: TierLabel) => renderModelLabel(ctx, theme, skin, serviceTier, suppressLiveBadge);
		let modelLabel = label(tier);
		let thinking = ctx.model?.reasoning
			? `${glyph(theme, set.thinking, "muted")} ${renderThinking(theme, ctx.thinkingLevel ?? "off")}`
			: undefined;
		const identity = () => cluster([modelLabel, thinking], "  ");
		// Shed the last request, current tier and effort as whole fields before truncating the model.
		if (tier?.observed && visibleWidth(identity()) > identityRoom) modelLabel = label({ ...tier, observed: undefined });
		if (tier && visibleWidth(identity()) > identityRoom) modelLabel = label();
		if (thinking && visibleWidth(identity()) > identityRoom) thinking = undefined;
		return identity();
	};
	const buildLayout = (suppressLiveBadge: boolean) => {
		const compactIdentity = buildIdentity(suppressLiveBadge);
		const tail = compactMode ? [
			renderPrice(ctx, s, theme, set),
			theme.fg("dim", fmtDuration(s.durationMs)),
			...(collaborationStatus ? [collaborationStatus] : []),
		] : [];
		const statusRoom = identityRoom - visibleWidth(compactIdentity);
		const modes = modeStatus && visibleWidth(modeStatus) + 2 <= statusRoom ? modeStatus : undefined;
		const modeWidth = modes ? visibleWidth(modes) + 2 : 0;
		const fitsBeside = (status: string) => visibleWidth(status) + 2 <= statusRoom - modeWidth;
		const workflow = Array.isArray(workflowStatus) ? fitCompactStatuses(workflowStatus, fitsBeside) : workflowStatus;
		// Fit modes first, then workflow, language and spokesman, independently of which band draws them.
		const [activity, language, spokesman] = [
			[workflow, languageStatus, spokesmanStatus],
			[workflow, languageStatus],
			[workflow],
		].find(parts => fitsBeside(cluster(parts, "  "))) ?? [];
		const leftStatuses = cluster([activity, spokesman], "  ");
		const rightStatuses = cluster([language, modes], "  ");
		const context = renderContext(theme, usage, barWidth, s.compactions, set.compact, Infinity, contextOptions);
		const right = cluster([rightStatuses, context, ...tail], "  ");
		const left = cluster([compactIdentity, provider, leftStatuses], "  ");
		return { compactIdentity, leftStatuses, rightStatuses, tail, left, right };
	};
	const clean = buildLayout(true);
	const phase = renderLivePhase(ctx, theme, state);
	const availableGap = width - visibleWidth(clean.left) - visibleWidth(clean.right) - (chrome - 1);
	const minPillGap = visibleWidth(phase.text) + (chrome > 3 ? (hasNerdFonts() ? 6 : 4) : 2);
	if (visibleWidth(clean.left) + visibleWidth(clean.right) + chrome <= width && availableGap >= minPillGap) {
		return skin.bar(clean.left, clean.right, width, { text: phase.text, pill: true, tint: phase.tint });
	}

	// Too narrow for the center state pill: keep live/queued indicators on the left and omit the pill.
	const fallback = buildLayout(false);
	if (visibleWidth(fallback.left) + visibleWidth(fallback.right) + chrome <= width) {
		return skin.bar(fallback.left, fallback.right, width);
	}

	// Keep identity and context percent; shed provider, token counts, and compact extras first.
	const reserved = fallback.rightStatuses ? visibleWidth(fallback.rightStatuses) + 2 : 0;
	const left = truncateToWidth(cluster([fallback.compactIdentity, fallback.leftStatuses], "  "), Math.max(0, identityRoom - reserved));
	const budget = Math.max(0, width - visibleWidth(left) - chrome - reserved);
	while (fallback.tail.length && visibleWidth(cluster(fallback.tail, "  ")) + 2 + minimumContext > budget) fallback.tail.pop();
	const contextBudget = Math.max(0, budget - (fallback.tail.length ? visibleWidth(cluster(fallback.tail, "  ")) + 2 : 0));
	return skin.bar(left, cluster([
		fallback.rightStatuses,
		renderContext(theme, usage, barWidth, s.compactions, set.compact, contextBudget, contextOptions),
		...fallback.tail,
	], "  "), width);
}

function renderCompact(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	width: number,
	state: SessionState,
	footerData: ReadonlyFooterDataProvider,
): string {
	const statuses = footerData.getExtensionStatuses();
	const compactKeys = Object.keys(STATUS_DESCRIPTORS).filter(key => STATUS_DESCRIPTORS[key]!.compact && statuses.get(key));
	const workflowKey = compactKeys.find(key => STATUS_DESCRIPTORS[key]!.compact === "workflow");
	const processKey = compactKeys.find(key => STATUS_DESCRIPTORS[key]!.compact === "process");
	const workflow = statuses.get("herder") || statuses.get("goal")
		? compactKeys.map((key, index): CompactStatus => {
			const text = statuses.get(key)!;
			const plain = stripAnsi(text);
			const severity = statusRank(plain);
			const marker = severityMarker(plain, severity);
			let short = text;
			if (!text.includes("\x1b[")) {
				// Herder's operation precedes its optional task count.
				if (key === "herder") short = text.replace(/ · \d+\/\d+ tasks$/, "");
				else if (key === "goal" && severity === 1 && compactKeys.length > 1 && visibleWidth(text) > 24) {
					short = truncateToWidth(text, 24, "…");
				}
				// Keep research's current phase, but never discard attention or problem details.
				else if (key === "autoresearch" && severity === 1 && text.startsWith("research · ")) {
					short = text.split(" · ").slice(0, 2).join(" · ");
				}
			}
			return {
				text: renderStatus(theme, text, key),
				shortText: short !== text ? renderStatus(theme, short, key) : undefined,
				fallbackText: key === "magpie-quota" && marker
					? renderStatus(theme, `quota ${marker}`, key)
					: undefined,
				abbreviate: key === "herder" || key === "goal",
				abbreviateAbove: key === "goal" ? 16 : undefined,
				severityMarker: key === "herder" || key === "goal" ? marker : undefined,
				rank: severity * (compactKeys.length + 2) + (key === "herder" ? compactKeys.length + 1 : key === "goal" ? compactKeys.length : compactKeys.length - index - 1),
			};
		})
		: cluster([
			workflowKey && renderStatus(theme, statuses.get(workflowKey)!, workflowKey),
			processKey && renderStatus(theme, statuses.get(processKey)!, processKey),
		], "  ");
	const representative = statusText(statuses, "representative");
	const rooms = additionalRooms(statuses);
	const collaboration = cluster([
		representative && renderStatus(theme, representative, "representative", hasNerdFonts()),
		rooms && `${glyph(theme, icons().relay, "dim")} ${theme.fg("muted", rooms)}`,
	], "  ");
	return renderIdentityRow(
		pi,
		ctx,
		theme,
		skin,
		width,
		state,
		collectStats(ctx, state),
		true,
		renderLanguage(theme, statuses),
		workflow,
		renderSpokesman(theme, statuses),
		renderModes(theme, statuses, ctx.sessionManager.getSessionId()),
		collaboration,
	);
}

/** Cached reads as a share of all input, and the color that rates it. */
function cacheHit(s: Stats): { pct: number | null; color: ThemeToken } {
	const totalIn = s.input + s.cacheRead + s.cacheWrite;
	const pct = totalIn > 0 ? Math.round((s.cacheRead / totalIn) * 100) : null;
	return { pct, color: pct == null ? "dim" : pct >= 70 ? "success" : pct >= 40 ? "warning" : "dim" };
}

function gitColor(status: GitStat["status"]): ThemeToken {
	return status === "clean" ? "success" : status === "dirty" ? "warning" : status === "unavailable" ? "error" : "dim";
}

function ttftColor(ms: number): "success" | "warning" | "error" {
	if (ms < 2_000) return "success";
	if (ms < 8_000) return "warning";
	return "error";
}

/**
 * Full mode's width tiers. The tier comes from the render width alone, never from the
 * content's width, so the row count holds still while metrics and Git state change.
 */
export const FOOTER_TIERS = { deskMin: 175, phoneMax: 71 } as const;

type FooterTier = "desk" | "laptop" | "phone";

/**
 * How long each group of a tier's rows lasts when the row is short of space; lower ranks drop first.
 * Actionable facts outlast diagnostics, and failed tool calls outlast all but the most actionable.
 */
export const DESK_RANKS = { memory: 0, think: 1, tools: 2, tokens: 3, latency: 4, turns: 5, toolErrors: 6, cost: 7 } as const;
export const LAPTOP_RANKS = { cache: 0, latency: 1, turns: 2, cwd: 3, cost: 4, errors: 5, git: 6 } as const;

function footerTier(width: number): FooterTier {
	if (width >= FOOTER_TIERS.deskMin) return "desk";
	return width <= FOOTER_TIERS.phoneMax ? "phone" : "laptop";
}

function renderFull(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	state: SessionState,
): string[] {
	const s = collectStats(ctx, state);
	const extensionStatuses = footerData.getExtensionStatuses();
	const tier = footerTier(width);
	if (tier === "phone") return [renderPhone(ctx, theme, width, state, s, extensionStatuses)];
	const line1 = renderIdentityRow(
		pi,
		ctx,
		theme,
		skin,
		width,
		state,
		s,
		false,
		renderLanguage(theme, extensionStatuses),
		undefined,
		renderSpokesman(theme, extensionStatuses),
		renderModes(theme, extensionStatuses, ctx.sessionManager.getSessionId()),
	);

	return [line1, ...renderDetailRows(ctx, theme, footerData, width, state, s, tier)];
}

/** A model id without its vendor prefix, keeping the version: `claude-opus-5-5` reads `opus-5-5`. */
function shortModelName(id: string): string {
	return id.replace(/^.*\//, "").replace(/^(?:claude|anthropic)-/i, "") || id;
}

/**
 * `herder blocked`, `quota awaiting`, `bg 1 failed`: a status's leading word and its marker, with the
 * marker's count. A status that opens with a symbol or with the marker itself is named by its key.
 */
function phoneAlert(plain: string, key = ""): string | undefined {
	const marker = severityMarker(plain);
	if (!marker) return undefined;
	const match = new RegExp(`(?:^|[\\s:])${marker}(?=$|[\\s,.;:)])`).exec(plain)!;
	const count = /(?:^|\s)(\d+)\s+$/.exec(plain.slice(0, match.index + match[0].length - marker.length))?.[1];
	const word = /^\p{L}[\p{L}\p{N}_-]*/u.exec(plain)?.[0];
	const label = word && word.toLowerCase() !== marker.toLowerCase() ? word : key.replace(/^(?:magpie|pi)-/, "");
	return cluster([label, count, marker], " ");
}

/**
 * The phone tier: one row of plain text joined by ` · `, without Nerd Font glyphs, bands, or caps,
 * because the font support of Orca's mobile WebView is unknown. The tail drops from the end; the
 * model and context percentage stay, and the model is truncated before the percentage goes.
 */
function renderPhone(
	ctx: ExtensionContext,
	theme: Theme,
	width: number,
	state: SessionState,
	s: Stats,
	statuses: ReadonlyMap<string, string>,
): string {
	const model = ctx.model;
	const usage = ctx.getContextUsage();
	const sep = theme.fg("dim", " · ");
	const live = !ctx.isIdle();
	const elapsedMs = live && state.phaseStartedAt > 0 ? Math.max(0, Date.now() - state.phaseStartedAt) : 0;
	const liveMark = live
		? theme.fg("success", theme.bold(elapsedMs >= 1_000 ? `● ${fmtPhaseElapsed(elapsedMs)}` : "●"))
		: undefined;
	const queuedMark = ctx.hasPendingMessages() ? theme.fg("warning", "queued") : undefined;
	const name = theme.fg("accent", theme.bold(model ? shortModelName(model.id) : "no-model"));
	let thinking = model?.reasoning ? renderThinking(theme, ctx.thinkingLevel ?? "off") : undefined;
	const context = usage?.percent != null ? theme.fg("muted", `${usage.percent.toFixed(1)}%`) : undefined;
	const unpriced = s.priceUnavailable || priceUnavailableForModel(ctx);
	const cost = unpriced
		? theme.fg("warning", "price?")
		: theme.fg("text", `${s.priceEstimated ? "~" : ""}${fmtCost(s.cost)}`);
	// Only statuses that need the user; problems before attention.
	const alerts = activityStatuses(statuses)
		.map(([key, text]) => ({ key, plain: stripAnsi(text) }))
		.sort((a, b) => statusRank(b.plain) - statusRank(a.plain))
		.flatMap(({ key, plain }) => {
			const alert = phoneAlert(plain, key);
			return alert ? [renderStatus(theme, alert, key)] : [];
		});
	const room = Math.max(0, width - 1);
	const tail = [cost, ...alerts];
	const line = (head: string) => cluster([liveMark, queuedMark, head, thinking, context, ...tail], sep);
	while (tail.length && visibleWidth(line(name)) > room) tail.pop();
	if (visibleWidth(line(name)) > room) thinking = undefined;
	const rest = line("");
	const fitted = truncateToWidth(name, Math.max(0, room - visibleWidth(rest) - (rest ? 3 : 0)), "…");
	return truncateToWidth(` ${line(fitted)}`, width);
}

// ── detail rows ────────────────────────────────────────────────────
// Under the bar, the optional activity row and the tier's rows hang from the
// chip on a rail: telemetry and workspace at a desk, one essentials row on a
// laptop. Facts come in groups split by `│` dividers that match the rail.
// Icons carry the hue and values stay muted, unless a value
// reports a state such as a slow first token or failed tool calls. A row that
// does not fit drops whole groups, least important first, instead of cutting
// text, and the path shortens from the middle.

interface Group {
	text: string;
	severityMarker?: string;
	statusKey?: string;
	/** Lower ranks drop first when the row is short of space. */
	rank: number;
}

/** `display`, shortened from the middle to `max` columns while it keeps its last directories. */
export function shortenPath(display: string, max: number): string {
	if (visibleWidth(display) <= max) return display;
	const hostMatch = /^([^/:]+):(.*)$/.exec(display);
	if (hostMatch && !/^[A-Za-z]$/.test(hostMatch[1]!)) {
		const prefix = `${hostMatch[1]!}:`;
		const rest = hostMatch[2]!;
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth + 2 <= max) {
			return `${prefix}${shortenPath(rest, max - prefixWidth)}`;
		}
	}
	const parts = display.split("/");
	for (let keep = parts.length - 2; keep >= 1; keep--) {
		const candidate = [parts[0], "…", ...parts.slice(-keep)].join("/");
		if (visibleWidth(candidate) <= max) return candidate;
	}
	// Even the last directory is too long: keep its start. Paths are plain text, so no resets are needed.
	if (max <= 0) return "";
	let start = "";
	for (const char of parts.at(-1)!) {
		if (visibleWidth(start + char) > max - 1) break;
		start += char;
	}
	return `${start}…`;
}

/** Space for the groups after both margins, the rail and the gap between the two sides. */
function railRoom(width: number, gap = 3): number {
	return width - 2 - 2 - gap;
}

/** Columns the vertical divider between two groups takes, with its spacing. */
const RAIL_SEP_WIDTH = 5;

function railRow(theme: Theme, branch: string, left: Group[], right: Group[], width: number, metricRow = false): string {
	let pad = "  ";
	const sep = () => `${pad}${theme.fg("borderMuted", "│")}${pad}`;
	const join = (groups: Group[]) => groups.map(group => group.text).join(sep());
	const rail = `${theme.fg("borderMuted", branch)} `;
	const room = railRoom(width);
	left = [...left];
	right = [...right];
	while (left.length + right.length > 1) {
		const used = visibleWidth(join(left)) + visibleWidth(join(right));
		if (used <= room) break;
		// If the facts fit on the line, reclaim divider padding to keep the two sides apart.
		// A left-only metric row needs no gap at all.
		if (metricRow && used <= railRoom(width, right.length ? 1 : 0)) {
			if (!right.length) break;
			if (left.length > 1 || right.length > 1) {
				pad = " ";
				break;
			}
		}
		const weakest = [...left, ...right].reduce((a, b) => (b.rank < a.rank ? b : a));
		if (weakest.statusKey === "goal" && !weakest.severityMarker) {
			const excess = used - room;
			const available = visibleWidth(weakest.text) - excess;
			if (available >= 16) {
				weakest.text = truncateToWidth(weakest.text, available, "…");
				break;
			}
		}
		for (const groups of [left, right]) {
			const index = groups.indexOf(weakest);
			if (index >= 0) groups.splice(index, 1);
		}
	}
	const remaining = [...left, ...right];
	if (remaining.length === 1 && remaining[0]!.severityMarker && visibleWidth(remaining[0]!.text) > room) {
		const group = remaining[0]!;
		const marker = group.severityMarker!;
		if (visibleWidth(marker) <= room) {
			const prefixRoom = room - visibleWidth(marker) - 1;
			const prefix = prefixRoom > 1 ? truncateToWidth(group.text, prefixRoom, "…") : "";
			group.text = cluster([prefix, renderStatus(theme, marker, group.statusKey ?? "herder")], " ");
		}
	}
	return alignRow(rail + join(left), join(right), width);
}

function renderDetailRows(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	state: SessionState,
	s: Stats,
	tier: Exclude<FooterTier, "phone">,
): string[] {
	const set = icons();
	const item = (icon: string, hue: ThemeToken, value: string, tone: ThemeToken = "muted") =>
		`${glyph(theme, icon, hue)} ${theme.fg(tone, value)}`;
	const { metrics } = state;
	const avgTtft = avgTtftMs(metrics);
	const avg = avgTokPerSec(metrics);
	const { pct: cachePct, color: cacheColor } = cacheHit(s);

	const activity = cluster([
		item(set.turns, "dim", `${s.turns}`),
		item(set.elapsed, "dim", fmtDuration(s.durationMs)),
	], "  ");
	const ttft = avgTtft != null
		? item(set.ttft, ttftColor(avgTtft), fmtTtft(avgTtft), avgTtft < 2_000 ? "muted" : ttftColor(avgTtft))
		: "";
	const speed = avg != null ? item(set.speed, "success", fmtTokPerSec(avg)) : "";
	const errors = s.errors > 0
		? item(set.err, "error", `${s.errors}${s.toolCalls > 0 ? ` (${((s.errors / s.toolCalls) * 100).toFixed(1)}%)` : ""}`, "error")
		: "";

	const unpriced = s.priceUnavailable || priceUnavailableForModel(ctx);
	// The ASCII cost icon is itself a dollar sign, and the amount already has one.
	const costIcon = (value: string, tone: ThemeToken) =>
		hasNerdFonts() ? item(set.cost, "warning", value, tone) : theme.fg(tone, value);
	const amount = unpriced
		? costIcon("price unavailable", "warning")
		: costIcon(`${s.priceEstimated ? "~" : ""}${fmtCost(s.cost)}`, "text");
	const statuses = footerData.getExtensionStatuses();
	// Leave room between severity levels for Herder and collaboration tie-breakers.
	const rankStep = statuses.size + 3;
	const activityEntries = activityStatuses(statuses);
	const herderText = statuses.get("herder");
	const representative = statusText(statuses, "representative");
	const fittingPeer = herderText && statusRank(herderText) > 1 && visibleWidth(renderStatus(theme, herderText, "herder", hasNerdFonts())) > railRoom(width)
		&& (activityEntries.some(([key, text]) => key !== "herder" && statusRank(text) === statusRank(herderText)
			&& visibleWidth(renderStatus(theme, text, key, hasNerdFonts())) <= railRoom(width))
			|| Boolean(representative && statusRank(representative) === statusRank(herderText)
				&& visibleWidth(renderStatus(theme, representative, "representative", hasNerdFonts())) <= railRoom(width)));
	const leftStatuses = activityEntries.map(([key, text], index) => {
		const rank = statusRank(text);
		return {
			text: renderStatus(theme, text, key, hasNerdFonts()),
			severityMarker: key === "herder" || key === "goal" ? severityMarker(stripAnsi(text), rank) : undefined,
			statusKey: key,
			rank: rank * rankStep + (key === "herder" ? (fittingPeer ? -activityEntries.length : 3) : key === "goal" && rank === 1 ? 2 : -index),
		};
	});
	const relay = cluster([
		additionalRooms(statuses),
		s.relayIn > 0 && `${s.relayIn} in`,
		s.relayOut > 0 && `${s.relayOut} out`,
	], " · ");
	// Collaboration outlasts other routine summaries, while Herder keeps its operation visible.
	const collaboration: Group[] = [
		...(representative ? [{ text: renderStatus(theme, representative, "representative", hasNerdFonts()), rank: statusRank(representative) * rankStep + 1 }] : []),
		...(relay ? [{ text: item(set.relay, "dim", relay), rank: rankStep + 1 }] : []),
	];
	const activityRows = leftStatuses.length || collaboration.length
		? [railRow(theme, "├", leftStatuses, collaboration, width)] : [];

	refreshGitStat(ctx.cwd, state);
	const branch = footerData.getGitBranch();
	const { status, adds, dels, staged, unstaged, untracked, conflicts, worktree, ahead, behind } = state.gitStat;
	const color = gitColor(status);
	const dirtyParts: string[] = [];
	if (conflicts > 0) dirtyParts.push(theme.fg("error", theme.bold(`${set.err} ${conflicts} conflict${conflicts > 1 ? "s" : ""}`)));
	if (adds || dels) dirtyParts.push(`${theme.fg("toolDiffAdded", `+${adds ?? 0}`)} ${theme.fg("toolDiffRemoved", `−${dels ?? 0}`)}`);
	if (staged > 0) dirtyParts.push(theme.fg("success", `●${staged}`));
	if (untracked > 0) dirtyParts.push(theme.fg("warning", `?${untracked}`));
	if (dirtyParts.length === 0) {
		dirtyParts.push(unstaged > 0 ? theme.fg("warning", `~${unstaged}`) : theme.fg("warning", "dirty"));
	}
	const gitState = status === "clean"
		? item(set.ok, "success", "clean")
		: status === "dirty"
			? dirtyParts.join(" ")
			: status === "unavailable"
				? theme.fg("error", "git ?")
				: theme.fg("dim", "git …");
	const git = branch
		? cluster([
			`${glyph(theme, set.branch, color)} ${theme.fg("text", branch)}${worktree ? ` ${theme.fg("dim", "wt")}` : ""}`,
			gitState,
			(ahead > 0 || behind > 0) && `${theme.fg("success", `↑ ${ahead}`)}  ${theme.fg("warning", `↓ ${behind}`)}`,
		], "  ")
		: item(set.branch, "dim", "no git", "dim");
	// The path takes the room the row's other groups leave, so it shortens before they drop.
	const pathRoomFor = (left: Group[], right: Group[]): number => {
		const others = [...left, ...right];
		const seps = Math.max(0, left.length - 1) + right.length;
		return railRoom(width) - visibleWidth(`${set.cwd} `)
			- others.reduce((sum, group) => sum + visibleWidth(group.text), 0) - seps * RAIL_SEP_WIDTH;
	};
	const cwd = (left: Group[], right: Group[]): string =>
		item(set.cwd, "dim", shortenPath(formatWorkspacePath(ctx.cwd), Math.max(12, pathRoomFor(left, right))));

	const lastAnomaly = state.cacheLens.lastAnomalyBadge();
	const warmth = state.cacheLens.cacheWarmth();
	const warmthSuffix = !lastAnomaly && warmth?.active
		? `${theme.fg("dim", " · ")}${theme.fg(warmth.remainingMs < 60_000 ? "warning" : "dim", formatWarmthCountdown(warmth.remainingMs))}`
		: "";

	if (tier === "laptop") {
		// One row of what to act on.
		const left: Group[] = [
			{ text: git, rank: LAPTOP_RANKS.git },
			{ text: amount, rank: LAPTOP_RANKS.cost },
			{ text: activity, rank: LAPTOP_RANKS.turns },
			...(errors ? [{ text: errors, rank: LAPTOP_RANKS.errors }] : []),
		];
		const laptopLatency = cluster([ttft, speed], "  ");
		const laptopCache = lastAnomaly
			? item(set.cache, lastAnomaly.severity, `${cachePct ?? lastAnomaly.hitPct}% (${lastAnomaly.tag})`, lastAnomaly.severity)
			: cachePct != null
				? item(set.cache, cacheColor, `${cachePct}%`, cacheColor === "dim" ? "muted" : cacheColor) + warmthSuffix
				: "";
		const right: Group[] = [
			...(laptopLatency ? [{ text: laptopLatency, rank: LAPTOP_RANKS.latency }] : []),
			...(laptopCache ? [{ text: laptopCache, rank: LAPTOP_RANKS.cache }] : []),
		];
		return [...activityRows, railRow(theme, "╰", left, [...right, { text: cwd(left, right), rank: LAPTOP_RANKS.cwd }], width, true)];
	}

	const lastMark = `  ${set.last} `;
	const diagnosticTtfb = metrics.lastTtfbMs != null
		&& (metrics.lastTtfbMs >= 1_000 || (metrics.lastTtftMs != null && metrics.lastTtftMs - metrics.lastTtfbMs >= 2_000));
	const latency = cluster([
		ttft && (ttft + (metrics.lastTtftMs != null && metrics.ttftCount > 1 ? theme.fg("dim", ` (${fmtTtft(metrics.lastTtftMs)})`) : "")),
		diagnosticTtfb && item(set.ttfb, "dim", fmtTtft(metrics.lastTtfbMs!), "dim"),
		speed && (speed + (metrics.lastTokPerSec != null && metrics.requests > 1 ? theme.fg("dim", ` (${fmtTokPerSec(metrics.lastTokPerSec).replace(" tok/s", "")})`) : "")),
	], "  ");
	const tools = s.toolCalls > 0
		? cluster([item(set.calls, "syntaxFunction", `${s.toolCalls}`), errors], "  ")
		: errors;
	const cost = amount
		+ (!unpriced && s.turns > 1 ? theme.fg("dim", `  ${fmtCost(s.cost / s.turns)}/turn`) : "")
		+ (!unpriced && s.subagentCost >= 0.005 ? theme.fg("dim", `  (${fmtCost(s.subagentCost)} sub)`) : "");
	const cacheWriteSuffix = s.cacheWrite > 0 ? ` ${theme.fg("dim", `+${fmtTokens(s.cacheWrite)} wr`)}` : "";
	const cacheSegment = lastAnomaly
		? s.cacheRead > 0
			? `${item(set.cache, lastAnomaly.severity, fmtTokens(s.cacheRead))}${cachePct != null ? ` ${theme.fg(cacheColor === "dim" ? "muted" : cacheColor, `${cachePct}%`)}` : ""}${theme.fg("dim", lastMark)}${theme.fg(lastAnomaly.severity, `${lastAnomaly.hitPct}% (${lastAnomaly.tag})`)}`
			: item(set.cache, lastAnomaly.severity, `${lastAnomaly.hitPct}% (${lastAnomaly.tag})`, lastAnomaly.severity)
		: s.cacheRead > 0
			? item(set.cache, cacheColor, fmtTokens(s.cacheRead))
				+ (cachePct != null ? ` ${theme.fg(cacheColor === "dim" ? "muted" : cacheColor, `${cachePct}%`)}` : "")
				+ cacheWriteSuffix
				+ warmthSuffix
			: s.cacheWrite > 0
				? `${item(set.cache, "dim", `+${fmtTokens(s.cacheWrite)} wr`, "dim")}${warmthSuffix}`
				: "";
	const tokens = cluster([
		item(set.input, "dim", fmtTokens(s.input)),
		item(set.output, "muted", fmtTokens(s.output)),
		cacheSegment,
	], "  ");
	const memory = s.memoryTokens > 0 ? theme.fg("dim", `~${fmtTokens(s.memoryTokens)} memory`) : "";
	const think = s.reasoning > 0 ? theme.fg("dim", `${fmtTokens(s.reasoning)} think`) : "";
	// Performance on the left, resources on the right, in one row.
	const telemetry = railRow(theme, "├", [
		{ text: activity, rank: DESK_RANKS.turns },
		...(tools ? [{ text: tools, rank: s.errors > 0 ? DESK_RANKS.toolErrors : DESK_RANKS.tools }] : []),
		...(latency ? [{ text: latency, rank: DESK_RANKS.latency }] : []),
	], [
		{ text: cost, rank: DESK_RANKS.cost },
		{ text: tokens, rank: DESK_RANKS.tokens },
		...(memory ? [{ text: memory, rank: DESK_RANKS.memory }] : []),
		...(think ? [{ text: think, rank: DESK_RANKS.think }] : []),
	], width, true);
	const editedGroup: Group[] = s.files > 0 ? [{ text: item(set.edit, "dim", `${s.files} edited`), rank: 2 }] : [];
	const gitGroup: Group[] = [{ text: git, rank: 4 }];
	const rawSessionId = ctx.sessionManager.getSessionId()?.trim() ?? "";
	const shortId = rawSessionId ? rawSessionId.slice(0, 8) : "";
	const sessionIdGroup: Group[] = shortId ? [{ text: theme.fg("dim", `#${shortId}`), rank: 0 }] : [];

	const hasActivity = leftStatuses.length > 0 || collaboration.length > 0;
	const routineActivity = activityEntries.every(([, text]) => statusRank(text) < 2)
		&& (!representative || statusRank(representative) < 2);
	const compactActivityCount = leftStatuses.length + collaboration.length <= 2;
	const foldedLeft: Group[] = [...gitGroup, ...leftStatuses.map(group => ({ ...group, rank: 3.5 }))];
	const foldedCollab: Group[] = collaboration.map(group => ({ ...group, rank: 3.2 }));
	const foldedRightOther: Group[] = [...foldedCollab, ...editedGroup, ...sessionIdGroup];
	const foldRoutineIntoWorkspace = hasActivity
		&& routineActivity
		&& compactActivityCount
		&& pathRoomFor(foldedLeft, foldedRightOther) >= 20;

	const deskActivityRows = foldRoutineIntoWorkspace ? [] : activityRows;
	const wsLeft = foldRoutineIntoWorkspace ? foldedLeft : gitGroup;
	const wsRightBeforeCwd = foldRoutineIntoWorkspace ? [...foldedCollab, ...editedGroup] : editedGroup;
	const wsRightOther = [...wsRightBeforeCwd, ...sessionIdGroup];
	const wsRight: Group[] = [
		...wsRightBeforeCwd,
		{ text: cwd(wsLeft, wsRightOther), rank: 3 },
		...sessionIdGroup,
	];
	const workspace = railRow(theme, "╰", wsLeft, wsRight, width);
	return [...deskActivityRows, telemetry, workspace];
}

// ── extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: FooterMode = loadFooterMode();
	let installedCtx: ExtensionContext | undefined;
	let installedEditorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
	let stopWatchingProcesses: (() => void) | undefined;
	let stopWatchingSwarm: (() => void) | undefined;

	function installTitleEditor(ctx: ExtensionContext) {
		if (typeof ctx.ui.setEditorComponent !== "function") return;
		const existing = ctx.ui.getEditorComponent?.();
		if (existing && existing !== installedEditorFactory) return;
		const factory: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]> = (
			tui,
			editorTheme,
			keybindings,
		) =>
			new TitledEditor(
				tui,
				editorTheme,
				keybindings,
				() => (ctx.sessionManager as { getSessionName?: () => string | undefined }).getSessionName?.(),
				() => ctx.ui.theme,
			);
		installedEditorFactory = factory;
		ctx.ui.setEditorComponent(factory);
	}

	function uninstallTitleEditor(ctx: ExtensionContext) {
		if (!installedEditorFactory || typeof ctx.ui.setEditorComponent !== "function") {
			installedEditorFactory = undefined;
			return;
		}
		if (!ctx.ui.getEditorComponent || ctx.ui.getEditorComponent() === installedEditorFactory) {
			ctx.ui.setEditorComponent(undefined);
		}
		installedEditorFactory = undefined;
	}

	function install(ctx: ExtensionContext, state: SessionState) {
		if (ctx.mode !== "tui" || installedCtx === ctx) return;
		installedCtx = ctx;
		installTitleEditor(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			let disposed = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let scheduledDelay = 0;
			const nextDelay = () => (!ctx.isIdle() || state.cacheLens.cacheWarmth()?.active ? 1_000 : 30_000);
			const schedule = () => {
				if (disposed) return;
				if (timer) clearTimeout(timer);
				scheduledDelay = nextDelay();
				timer = setTimeout(() => {
					timer = undefined;
					scheduledDelay = 0;
					if (disposed) return;
					tui.requestRender();
					schedule();
				}, scheduledDelay);
				timer.unref?.();
			};
			const ensureTimerCadence = () => {
				if (!disposed && scheduledDelay > nextDelay()) schedule();
			};

			state.requestRender = () => {
				ensureTimerCadence();
				tui.requestRender();
			};
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			// Adaptive refresh: 1s while streaming or cache warmth is ticking, 30s when idle.
			schedule();

			return {
				dispose() {
					disposed = true;
					unsubBranch();
					if (timer) {
						clearTimeout(timer);
						timer = undefined;
					}
					scheduledDelay = 0;
				},
				invalidate() {},
				render(width: number): string[] {
					ensureTimerCadence();
					if (mode === "off") return [];
					const skin = skinFor(theme);
					return mode === "compact"
						? [renderCompact(pi, ctx, theme, skin, width, state, footerData)]
						: renderFull(pi, ctx, theme, skin, footerData, width, state);
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
		const entry = event.reason === "reload"
			? ctx.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === RELOAD_ENTRY)
			: undefined;
		const snapshot = entry?.type === "custom" ? restoreSnapshot(entry.data) : undefined;
		if (snapshot?.mode) mode = snapshot.mode;
		const state = freshSessionState(snapshot);
		sessionStates.set(sessionId, state);
		stopWatchingProcesses?.();
		stopWatchingProcesses = watchProcesses(pi.events, (status) => ctx.ui.setStatus(PROCESS_STATUS_KEY, status));
		stopWatchingSwarm?.();
		stopWatchingSwarm = watchSwarmBoard(sessionId, () => state.requestRender?.());
		if (mode !== "off") install(ctx, state);
	});

	// ── streaming metrics collection (TUI session only)

	pi.on("before_provider_request", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		state.serviceTier = extractServiceTier(event.payload, ctx.model?.api);
		const modelKey = ctx.model
			? (ctx.model.provider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id)
			: undefined;
		state.cacheLens.recordRequest(event.payload, {
			api: ctx.model?.api,
			modelKey,
		});
		state.livePhase = "waiting";
		state.phaseStartedAt = Date.now();
		state.requestRender?.();
	});

	pi.on("session_compact", (_event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		state.cacheLens.recordCompaction();
		state.lastContextTokens = undefined;
		state.lastContextDelta = undefined;
	});

	pi.on("session_tree", (_event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		state.cacheLens.resetBaseline();
		state.lastContextTokens = undefined;
		state.lastContextDelta = undefined;
	});

	pi.on("session_info_changed", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		getSessionState(ctx)?.requestRender?.();
	});

	pi.on("model_select", (_event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		state.serviceTier = undefined;
		state.requestRender?.();
	});

	pi.on("before_provider_headers", (_event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		const { metrics } = state;
		// Request is about to hit the wire (fires once per LLM call;
		// retries reuse the same headers and don't re-fire).
		const now = Date.now();
		metrics.headersSeen++;
		metrics.requestSentAt = now;
		metrics.firstTokenAt = 0;
		metrics.curTtftMs = null;
		state.livePhase = "waiting";
		state.phaseStartedAt = now;
		state.requestRender?.();
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
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui" || event.message.role !== "assistant") return;
		const { metrics } = state;
		const now = Date.now();
		// Fallback start marker for providers that never fire
		// before_provider_headers (stream consumption is beginning).
		if (metrics.requestSentAt === 0) {
			metrics.requestSentAt = now;
		}
		if (state.livePhase !== "waiting") {
			state.livePhase = "waiting";
			state.phaseStartedAt = now;
			state.requestRender?.();
		}
	});

	pi.on("message_update", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		const update = event.assistantMessageEvent;
		let isThinking = false;
		let isStreaming = false;
		if (update.type === "thinking_delta") {
			isThinking = update.delta.length > 0;
		} else if (update.type === "text_delta" || update.type === "toolcall_delta") {
			isStreaming = update.delta.length > 0;
		} else if (update.type === "thinking_start") {
			const block = update.partial.content[update.contentIndex];
			isThinking = block?.type === "thinking" && block.thinking.length > 0;
		} else if (update.type === "text_start") {
			const block = update.partial.content[update.contentIndex];
			isStreaming = block?.type === "text" && block.text.length > 0;
		} else if (update.type === "toolcall_start") {
			const block = update.partial.content[update.contentIndex];
			isStreaming = block?.type === "toolCall" && block.name.length > 0;
		}
		if (!isThinking && !isStreaming) return;

		const now = Date.now();
		const { metrics } = state;
		if (metrics.firstTokenAt === 0) {
			metrics.firstTokenAt = now;
			if (metrics.requestSentAt > 0) {
				metrics.curTtftMs = metrics.firstTokenAt - metrics.requestSentAt;
			}
		}

		const nextPhase: LivePhase = isThinking ? "thinking" : "streaming";
		if (state.livePhase !== nextPhase) {
			state.livePhase = nextPhase;
			state.phaseStartedAt = now;
			state.requestRender?.();
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui" || event.parentToolCallId) return;
		state.livePhase = "tool";
		state.activeToolName = event.toolName;
		state.activeToolCallId = event.toolCallId;
		state.phaseStartedAt = Date.now();
		state.requestRender?.();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui" || event.parentToolCallId) return;
		if (event.toolCallId === state.activeToolCallId) {
			state.livePhase = "idle";
			state.activeToolName = undefined;
			state.activeToolCallId = undefined;
			state.phaseStartedAt = 0;
		}
		if (MUTATING_TOOLS.has(event.toolName)) {
			state.gitStatAt = 0;
		}
		state.requestRender?.();
	});

	pi.on("message_end", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui" || event.message.role !== "assistant") return;
		state.cacheLens.recordMessageEnd(event.message);
		const { metrics } = state;
		const { usage, stopReason } = event.message;
		// The whole call, from the request to the last token, and only once content was observed.
		const callMs = metrics.requestSentAt > 0 && metrics.firstTokenAt > 0 ? Date.now() - metrics.requestSentAt : 0;
		// Ignore degenerate samples (no content observed, failed or aborted calls,
		// or instant responses too short to yield a meaningful rate).
		if (callMs >= 50 && usage && usage.output > 0 && stopReason !== "error" && stopReason !== "aborted") {
			metrics.totalOutput += usage.output;
			metrics.totalCallMs += callMs;
			metrics.lastTokPerSec = usage.output / (callMs / 1000);
			metrics.requests++;
			if (metrics.curTtftMs != null) {
				metrics.lastTtftMs = metrics.curTtftMs;
				metrics.totalTtftMs += metrics.curTtftMs;
				metrics.ttftCount++;
			}
		}
		metrics.requestSentAt = 0;
		metrics.firstTokenAt = 0;
		metrics.curTtftMs = null;
		if (state.livePhase !== "tool") {
			state.livePhase = "idle";
			state.phaseStartedAt = 0;
		}
		const tokens = ctx.getContextUsage()?.tokens;
		if (typeof tokens === "number" && typeof state.lastContextTokens === "number" && tokens > state.lastContextTokens) {
			state.lastContextDelta = tokens - state.lastContextTokens;
		} else {
			state.lastContextDelta = undefined;
		}
		state.lastContextTokens = typeof tokens === "number" ? tokens : undefined;
		state.requestRender?.();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopWatchingProcesses?.();
		stopWatchingProcesses = undefined;
		stopWatchingSwarm?.();
		stopWatchingSwarm = undefined;
		ctx.ui.setStatus(PROCESS_STATUS_KEY, undefined);
		uninstallTitleEditor(ctx);
		installedCtx = undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessionStates.get(sessionId);
		if (state) {
			state.requestRender = undefined;
			if (event.reason === "reload") {
				pi.appendEntry(RELOAD_ENTRY, {
					metrics: { ...state.metrics, requestSentAt: 0, firstTokenAt: 0, curTtftMs: null },
					serviceTier: state.serviceTier,
					cacheLens: state.cacheLens.toReloadSnapshot(),
					mode,
				});
			}
		}
		sessionStates.delete(sessionId);
	});

	pi.registerCommand("footer", {
		description: `Statusline footer: /footer [full|compact|off|default [full|compact|off]|debug]; full adapts to width (desk >= ${FOOTER_TIERS.deskMin} cols, phone <= ${FOOTER_TIERS.phoneMax}, laptop between)`,
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "footer", kind: "extension", extension: "statusline-footer" });
			const next = args.trim().toLowerCase().replace(/\s+/g, " ");
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
			if (next === "default" || next.startsWith("default ")) {
				const value = next.slice("default".length).trim();
				if (value === "") {
					ctx.ui.notify(`Default footer mode for new sessions: ${loadFooterMode()}`, "info");
					return;
				}
				if (value !== "full" && value !== "compact" && value !== "off") {
					ctx.ui.notify(
						`Unknown /footer default '${value}' — usage: /footer default [full|compact|off]`,
						"warning",
					);
					return;
				}
				await saveFooterMode(value);
				ctx.ui.notify(`Default footer mode for new sessions: ${value}`, "info");
				return;
			}
			if (next === "full" || next === "compact" || next === "off") {
				mode = next;
			} else if (next === "") {
				mode = mode === "off" ? "full" : "off";
			} else {
				ctx.ui.notify(
					`Unknown /footer argument '${args.trim()}' — usage: /footer [full|compact|off|default [full|compact|off]|debug]`,
					"warning",
				);
				return;
			}
			const state = getSessionState(ctx);
			if (mode === "off") {
				installedCtx = undefined;
				if (state) state.requestRender = undefined;
				uninstallTitleEditor(ctx);
				ctx.ui.setFooter(undefined); // restore pi's default footer
				ctx.ui.notify("Default footer restored", "info");
			} else if (state) {
				installedCtx = undefined; // force reinstall
				install(ctx, state);
				ctx.ui.notify(`Statusline footer: ${mode} mode`, "info");
			}
		},
	});

	pi.registerCommand("cache", {
		description: "Inspect session prefix KV cache hit rates and miss root causes: /cache [anomalies|reset]",
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "cache", kind: "extension", extension: "statusline-footer" });
			const next = args.trim().toLowerCase();
			const state = getSessionState(ctx);
			if (next === "" || next === "summary") {
				if (!state) {
					ctx.ui.notify("Cache lens unavailable outside the TUI session", "info");
					return;
				}
				await openCacheOverlay(ctx, state.cacheLens, {
					initialView: "all",
					onReset: () => {
						state.cacheLens.reset();
						state.requestRender?.();
					},
				});
				return;
			}
			if (next === "anomalies") {
				if (!state) {
					ctx.ui.notify("Cache lens unavailable outside the TUI session", "info");
					return;
				}
				await openCacheOverlay(ctx, state.cacheLens, {
					initialView: "anomalies",
					onReset: () => {
						state.cacheLens.reset();
						state.requestRender?.();
					},
				});
				return;
			}
			if (next === "reset") {
				if (!state) {
					ctx.ui.notify("Cache lens unavailable outside the TUI session", "info");
					return;
				}
				state.cacheLens.reset();
				state.requestRender?.();
				ctx.ui.notify("Cache lens diagnostics reset for this session", "info");
				return;
			}
			ctx.ui.notify(
				`Unknown /cache argument '${args.trim()}' — usage: /cache [anomalies|reset]`,
				"warning",
			);
		},
	});
}
