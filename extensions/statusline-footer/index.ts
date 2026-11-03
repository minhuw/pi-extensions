/**
 * Theme-aware statusline footer for Pi.
 *
 * Visual language is borrowed from pikit's footer: left/right justified rows,
 * a positional RGB gradient context bar, per-level thinking color (rainbow at
 * max/xhigh), a hairline rule, and Nerd Font icons with ASCII fallbacks.
 * Metrics remain ours: TTFT/TTFB, aggregate throughput, cache ratio,
 * session cost, and working-tree diff.
 *
 * Full mode:
 *   ✻ model  HIGH  (provider)                       ▉▉▉░░░  8.2% / 1.05M
 *   ────────────────────────────────────────────
 *   μ 4.2s  28.9 tok/s                    $0.75  96% cache  9 turns
 *   main  +42 −17                         5 touched  ~/code/my-project
 *   herder: T2 integrate · 3/5 tasks  ↻ build · next 4m   (while any status is set)
 *
 * Compact mode:
 *   model  HIGH            ▉▉▉░░░  42%  $1.23  12m
 *
 * Powerline style (/footer powerline) sets the identity row on theme bands:
 *   ▌✻ model ▶ HIGH  (provider) ▶ ──────── ◀ ▉▉▉░░░  8.2%  78.9k/1.05M ▐
 *
 * Usage:
 *   /footer            toggle on/off
 *   /footer full       multi-line layout (default)
 *   /footer compact    1-line layout
 *   /footer off        restore pi's default footer
 *   /footer powerline  identity row as a powerline bar
 *   /footer plain      identity row on the terminal background (default)
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
import { PROCESS_STATUS_KEY, watchProcesses } from "./processes.ts";

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

// ── skins ──────────────────────────────────────────────────────────
// A skin draws the identity row, the footer's status bar. The plain skin lays
// it on the terminal background with a hairline below. The powerline skin
// sets its groups on bands of the theme's tool surface, capped with powerline
// arrows (square ends without Nerd Fonts), and opens it with a chip in the
// model vendor's color; the band separates it, so it draws no hairline. The
// telemetry rows below stay plain either way, so the bar leads.

export type Style = "plain" | "powerline";

interface Skin {
	/** Columns the bar spends outside its content: margins, padding, caps, and the minimum gap. */
	chrome: number;
	bar(left: string, right: string, width: number): string;
	/** The rule under the bar, if the skin draws one. */
	rule(width: number): string | undefined;
	/** A chip that opens the bar's left group, if the skin draws chips. */
	chip?(text: string, color: Rgb): string;
}

const BAND_TOKEN = "toolPendingBg";
const POWERLINE = { left: "\u{E0B0}", right: "\u{E0B2}", thinLeft: "\u{E0B1}", thinRight: "\u{E0B3}" };

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

function plainSkin(theme: Theme): Skin {
	return { chrome: 3, bar: alignRow, rule: width => hairline(width, theme) };
}

/** The powerline skin on `surface`, a theme background's opening sequence, with `rule` the rule token's sequences. */
function powerlineSkin(surface: string, [ruleOpen, ruleClose]: [string, string], nerd: boolean): Skin {
	const capInk = surface.replace("\x1b[48;", "\x1b[38;");
	const surfaceRgb = backgroundRgb(surface);
	const lifted = new Map<string, string[]>();
	// Theme colors are chosen for the terminal background; lift truecolor text that would fade into the band.
	const lift = (color: string[]): string[] => {
		if (!surfaceRgb || color[1] !== "2") return color;
		const key = color.join(";");
		let legible = lifted.get(key);
		if (!legible) {
			const { r, g, b } = legibleOn({ r: Number(color[2]), g: Number(color[3]), b: Number(color[4]) }, surfaceRgb);
			legible = ["38", "2", `${r}`, `${g}`, `${b}`];
			lifted.set(key, legible);
		}
		return legible;
	};
	// Rewrites one SGR sequence for the band: a reset or default background reopens the surface,
	// faint is dropped because it would fade into the band, and foregrounds are lifted.
	const reband = (params: string): string => {
		const codes = params === "" ? ["0"] : params.split(";");
		const kept: string[] = [];
		let reopen = false;
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i] || "0";
			if ((code === "38" || code === "48") && (codes[i + 1] === "2" || codes[i + 1] === "5")) {
				const color = codes.slice(i, i + (codes[i + 1] === "2" ? 5 : 3));
				i += color.length - 1;
				if (code === "48") reopen = false;
				kept.push(...(code === "38" ? lift(color) : color));
				continue;
			}
			if (code === "0" || code === "49") reopen = true;
			if (code === "2" || code === "49") continue;
			kept.push(code);
		}
		return `${kept.length ? `\x1b[${kept.join(";")}m` : ""}${reopen ? surface : ""}`;
	};
	// Padding on both sides of the content, plus the cap.
	const side = nerd ? 3 : 2;
	const chipEnd = `${surface}\x1b[39m`;
	const closeChip = (color: Rgb) => `\x1b[22m${nerd ? `${surface}${rgbFg(color)}${POWERLINE.left}` : ""}${chipEnd}`;
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
		const body = rest.replace(/\x1b\[([0-9;]*)m/g, (_, params: string) => reband(params));
		const fill = `${chip || `${surface} `}${body}${surface} ${RESET}`;
		if (!nerd) return fill;
		return end === "left"
			? `${fill}${capInk}${POWERLINE.left}${RESET}`
			: `${capInk}${POWERLINE.right}${RESET}${fill}`;
	};
	return {
		chrome: 2 * side + 1,
		bar(left, right, width) {
			if (!right) return truncateToWidth(band(truncateToWidth(left, Math.max(0, width - side)), "left"), width);
			const rightWidth = visibleWidth(right);
			if (rightWidth + side >= width) {
				return truncateToWidth(band(truncateToWidth(right, Math.max(0, width - side)), "right"), width);
			}
			const leftStr = truncateToWidth(left, Math.max(0, width - rightWidth - 2 * side - 1));
			const leftBand = visibleWidth(leftStr) > 0 ? band(leftStr, "left") : "";
			const gap = Math.max(1, width - visibleWidth(leftBand) - rightWidth - side);
			// A rule across the gap joins the two bands into one bar.
			const fill = gap >= 3 ? ` ${ruleOpen}${"─".repeat(gap - 2)}${ruleClose || RESET} ` : " ".repeat(gap);
			return truncateToWidth(`${leftBand}${fill}${band(right, "right")}`, width);
		},
		rule: () => undefined,
		// Vendor colors need truecolor; a 256-color bar draws the model as plain text on the band.
		...(surface.startsWith("\x1b[48;2;") && {
			chip(text: string, color: Rgb) {
				return `${rgbBg(color)}${rgbFg(chipInk(color))}\x1b[1m ${text} ${closeChip(color)}`;
			},
		}),
	};
}

let cachedSkin: { key: string; skin: Skin } | undefined;

/**
 * The skin for `style`, or the plain skin where the theme cannot carry a band. Pi gives the
 * footer one theme object for the whole session and swaps the theme behind it, so the skin
 * is cached by the sequences it draws with, never by the object.
 */
export function skinFor(theme: Theme, style: Style): Skin {
	if (style !== "powerline") return plainSkin(theme);
	const [surface] = tokenAnsi(text => theme.bg(BAND_TOKEN, text));
	// A terminal-default surface leaves no band to draw.
	if (!surface.startsWith("\x1b[48;")) return plainSkin(theme);
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
// (bold for problems), never red; whole words only, so a loop named
// "fix-errors" stays calm. A publisher that styles its own text keeps it.

const STATUS_PROBLEM = /(?:^|[\s:])(?:fail(?:ed|ure|s)?|errors?|stuck|blocked|not_met)(?=$|[\s,.;:)])/i;
const STATUS_ATTENTION = /(?:^|[\s:])(?:paused|awaiting|stopping|killed|for you)(?=$|[\s,.;:)])/i;

export function statusTone(segment: string): "problem" | "attention" | "calm" {
	if (STATUS_PROBLEM.test(segment)) return "problem";
	if (STATUS_ATTENTION.test(segment)) return "attention";
	return "calm";
}

// Known extensions keep a fixed slot so their color does not move as others come and go.
const STATUS_ORDER = ["autoresearch", "herder", "loop", PROCESS_STATUS_KEY, "subagents", "superagent", "impeccable-live"];
const STATUS_ICONS: Record<string, string> = {
	autoresearch: "\u{F0093}", // md-flask
	herder: "\u{F0CC6}", // md-sheep
	loop: "\u{F04E6}", // md-sync
	[PROCESS_STATUS_KEY]: "\u{F018D}", // md-console
	subagents: "\u{F06A9}", // md-robot
	superagent: "\u{F0913}", // md-ticket-outline
	"impeccable-live": "\u{F03D8}", // md-palette
};
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
	let slot = STATUS_ORDER.indexOf(key);
	if (slot < 0) slot = [...key].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) >>> 0, 7);
	return palette[slot % palette.length]!;
}

export function renderStatus(theme: Theme, text: string, key = "", withIcon = false): string {
	if (text.includes("\x1b[")) return text;
	const identity = statusHue(theme, key);
	// A status that leads with its own symbol (such as Loop's ↻) needs no second icon.
	const icon = withIcon && /^[\p{L}\p{N}]/u.test(text)
		? `${theme.fg(identity, STATUS_ICONS[key] ?? STATUS_DEFAULT_ICON)} `
		: "";
	return icon + text.split(/( · |, )/).map((part, index) => {
		if (index % 2) return theme.fg("dim", part);
		const tone = statusTone(part);
		if (tone === "problem") return theme.fg("warning", theme.bold(part));
		if (tone === "attention") return theme.fg("warning", part);
		return theme.fg(index === 0 ? identity : "muted", part);
	}).join("");
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
	priceUnavailable: boolean;
	priceEstimated: boolean;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	turns: number;
	compactions: number;
	errors: number;
	toolCalls: number;
	files: number;
	durationMs: number;
}

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
		priceUnavailable: false,
		priceEstimated: false,
		cacheRead: 0,
		cacheWrite: 0,
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
		if (e.type === "custom" && e.customType === "magpie-pricing") {
			const pricing = (e.data as { pricing?: unknown } | undefined)?.pricing;
			if (pricing === "unavailable") s.priceUnavailable = true;
			if (pricing === "estimate") s.priceEstimated = true;
			continue;
		}
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
			addUsage(s, a.usage, a.provider);
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
	files?: number;
	adds?: number;
	dels?: number;
	ahead: number;
	behind: number;
}

// Keep telemetry keyed by session so child lifecycle and stream events cannot
// reset or corrupt the interactive parent's footer. Actual reloads replace this
// module; only the small custom-entry snapshot survives them.
const sessionStates = new Map<string, SessionState>();
const RELOAD_ENTRY = "statusline-footer:reload";
type ReloadSnapshot = Pick<SessionState, "metrics" | "serviceTier">;

function restoreSnapshot(data: unknown): ReloadSnapshot | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const { metrics, serviceTier } = data as Record<string, unknown>;
	if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return undefined;
	if (serviceTier !== undefined && typeof serviceTier !== "string") return undefined;

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
	return { metrics: restored, serviceTier };
}

function freshSessionState(previous?: ReloadSnapshot): SessionState {
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
	execFile("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"], opts, (err, stdout) => {
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
// Nerd Fonts are assumed; STATUSLINE_NERD_FONTS=0 (or FOOTER_NERD_FONTS=0)
// selects the ASCII/Unicode set for a terminal without them.

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
	compact: "\u{F0615}", // md-arrow-collapse
	elapsed: "\u{F0954}", // md-clock
	turns: "\u{F0368}", // md-message-reply-text
	input: "\u{F005E}", // md-arrow-up-thick
	output: "\u{F0046}", // md-arrow-down-thick
	cache: "\u{F140B}", // md-lightning-bolt
	cost: "\u{F01C1}", // md-currency-usd
	ttft: "\u{F051B}", // md-timer-outline
	ttfb: "\u{F04E1}", // md-swap-horizontal
	speed: "\u{F04C5}", // md-speedometer
	last: "\u{F02DA}", // md-history
	calls: "\u{F05B7}", // md-wrench
	err: "\u{F0159}", // md-close-circle
	ok: "\u{F0133}", // md-checkbox-marked-circle
	branch: "\u{F062C}", // md-source-branch
	file: "\u{F0224}", // md-file-outline
	cwd: "\u{F0770}", // md-folder-open
};

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

export function thinkingCaps(level: string): string {
	return level.toUpperCase();
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
	skin: Skin,
	includeProvider: boolean,
	live = false,
	queued = false,
	serviceTier?: string,
): string {
	const model = ctx.model;
	const queuedMark = queued && theme.fg("warning", "queued");
	const details = model && modelDetails(ctx, theme, includeProvider, serviceTier);
	const brand = model && modelBrand(model.id, model.provider);
	// A chip carries the live dot and the vendor mark in its own ink.
	const chipColor = skin.chip && ((brand?.color && hexToRgb(brand.color)) || resolveThemeRgb(theme, "accent"));
	if (skin.chip && chipColor) {
		const mark = brand ? `${hasNerdFonts() ? brand.nerd : brand.plain} ` : "";
		return cluster([
			skin.chip(`${live ? "● " : ""}${mark}${model?.id ?? "no-model"}`, chipColor),
			queuedMark,
			details,
		], "  ");
	}
	const liveMark = live && theme.fg("success", theme.bold("●"));
	const name = model
		? renderModelMark(theme, model.id, model.provider) + theme.fg("accent", theme.bold(model.id))
		: theme.fg("accent", theme.bold("no-model"));
	return cluster([liveMark, queuedMark, name, details], "  ");
}

/** Thinking level, non-standard service tier, and provider, each separated by two spaces. */
function modelDetails(ctx: ExtensionContext, theme: Theme, includeProvider: boolean, serviceTier?: string): string {
	const model = ctx.model!;
	const tier = displayServiceTier(serviceTier);
	return cluster([
		model.reasoning && renderThinking(theme, ctx.thinkingLevel ?? "off"),
		tier && theme.fg("warning", theme.bold(tier)),
		includeProvider && model.provider && theme.fg("dim", `(${model.provider})`),
	], "  ");
}

function renderContext(
	theme: Theme,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
	barWidth: number,
	compactions: number,
	compactIcon: string,
	maxWidth = Infinity,
): string {
	const compact = glyph(theme, compactIcon, compactions > 0 ? "warning" : "dim") + " " +
		theme.fg(compactions > 0 ? "warning" : "dim", `${compactions}×`);
	if (usage?.percent != null) {
		const pct = usage.percent;
		const used = fmtTokens(usage.tokens ?? 0);
		const window = fmtTokens(usage.contextWindow);
		const percent = theme.fg("muted", `${pct.toFixed(1)}%`);
		const counts = theme.fg("dim", `${used}/${window}`);
		const barSpace = maxWidth - visibleWidth(cluster([compact, percent, counts], "  ")) - 2;
		if (barSpace >= 4) {
			return cluster([compact, gradientBar(pct, Math.min(barWidth, barSpace), theme), percent, counts], "  ");
		}
		const prefix = compactions > 0 ? compact : "";
		const remaining = maxWidth - visibleWidth(cluster([prefix, percent], "  ")) - 2;
		return remaining >= 4
			? cluster([prefix, gradientBar(pct, Math.min(barWidth, remaining), theme), percent], "  ")
			: truncateToWidth(percent, Math.max(0, maxWidth));
	}
	if (usage?.contextWindow) {
		return truncateToWidth(cluster([compact, theme.fg("dim", `/ ${fmtTokens(usage.contextWindow)}`)], "  "), maxWidth);
	}
	return truncateToWidth(compact, maxWidth);
}

function priceUnavailableForModel(ctx: ExtensionContext): boolean {
	const model = ctx.model as (NonNullable<ExtensionContext["model"]> & { magpiePricing?: MagpiePricing }) | undefined;
	if (model?.provider !== "magpie") return false;
	if (model.magpiePricing === "unavailable") return true;
	if (model.magpiePricing === "estimate") return false;
	return model.cost.input === 0 && model.cost.output === 0
		&& model.cost.cacheRead === 0 && model.cost.cacheWrite === 0;
}

function renderPrice(ctx: ExtensionContext, s: Stats, theme: Theme, set: IconSet, perTurn = false): string {
	const unavailable = s.priceUnavailable || priceUnavailableForModel(ctx);
	const amount = unavailable ? "price unavailable" : `${s.priceEstimated ? "~" : ""}${fmtCost(s.cost)}`;
	// The ASCII cost icon is itself a dollar sign; the amount already contains one.
	const icon = hasNerdFonts() ? `${glyph(theme, set.cost, "warning")} ` : "";
	return theme.fg("warning", `${icon}${amount}`)
		+ (!unavailable && perTurn && s.turns > 0
			? theme.fg("dim", ` (~${fmtCost(s.cost / s.turns)}/turn)`)
			: "");
}

function renderIdentityRow(
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	width: number,
	state: SessionState,
	s: Stats,
	compactMode: boolean,
	workflowStatus?: string,
): string {
	const set = icons();
	const { chrome } = skin;
	const usage = ctx.getContextUsage();
	const barWidth = compactMode ? COMPACT_BAR_WIDTH : BAR_WIDTH;
	const label = (includeProvider: boolean) => renderModelLabel(
		ctx, theme, skin, includeProvider, !ctx.isIdle(), ctx.hasPendingMessages(), state.serviceTier,
	);
	let left = label(!compactMode);
	const tail = compactMode ? [
		renderPrice(ctx, s, theme, set),
		theme.fg("dim", fmtDuration(s.durationMs)),
	] : [];
	const context = renderContext(theme, usage, barWidth, s.compactions, set.compact);
	const right = cluster([context, ...tail], "  ");
	const loop = compactMode && workflowStatus ? workflowStatus : "";
	if (loop && visibleWidth(left) + visibleWidth(loop) + visibleWidth(right) + chrome + 2 <= width) {
		return skin.bar(cluster([left, loop], "  "), right, width);
	}
	const minimumContext = usage?.percent != null ? visibleWidth(`${usage.percent.toFixed(1)}%`) : 0;
	// Compact already renders the provider-free label, so it is the fallback identity too.
	const compactIdentity = compactMode ? left : label(false);
	const showLoop = Boolean(loop) && visibleWidth(compactIdentity) + visibleWidth(loop) + minimumContext + chrome + 2 <= width;
	if (!showLoop && visibleWidth(left) + visibleWidth(right) + chrome <= width) return skin.bar(left, right, width);

	// Keep identity and context percent; shed provider, token counts, and compact extras first.
	left = showLoop ? cluster([compactIdentity, loop], "  ") : compactIdentity;
	// A status is optional: never shorten the model or percent to make space for it.
	left = truncateToWidth(left, Math.max(0, width - minimumContext - chrome));
	const budget = Math.max(0, width - visibleWidth(left) - chrome);
	while (tail.length && visibleWidth(cluster(tail, "  ")) + 2 + minimumContext > budget) tail.pop();
	const contextBudget = Math.max(0, budget - (tail.length ? visibleWidth(cluster(tail, "  ")) + 2 : 0));
	return skin.bar(left, cluster([
		renderContext(theme, usage, barWidth, s.compactions, set.compact, contextBudget),
		...tail,
	], "  "), width);
}

function renderCompact(
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	width: number,
	state: SessionState,
	footerData: ReadonlyFooterDataProvider,
): string {
	const statuses = footerData.getExtensionStatuses();
	const workflowKey = ["autoresearch", "herder", "loop"].find((key) => statuses.get(key));
	return renderIdentityRow(ctx, theme, skin, width, state, collectStats(ctx, state), true, cluster([
		workflowKey && renderStatus(theme, statuses.get(workflowKey)!, workflowKey),
		statuses.get(PROCESS_STATUS_KEY) && renderStatus(theme, statuses.get(PROCESS_STATUS_KEY)!, PROCESS_STATUS_KEY),
	], "  "));
}

function ttftColor(ms: number): "success" | "warning" | "error" {
	if (ms < 2_000) return "success";
	if (ms < 8_000) return "warning";
	return "error";
}

function renderFull(
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	state: SessionState,
): string[] {
	const set = icons();
	const s = collectStats(ctx, state);
	const sep = "  ";

	const line1 = renderIdentityRow(ctx, theme, skin, width, state, s, false);

	const { metrics } = state;
	const avgTtft = avgTtftMs(metrics);
	const avg = avgTokPerSec(metrics);
	const totalIn = s.input + s.cacheRead + s.cacheWrite;
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
		renderPrice(ctx, s, theme, set, true),
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
	const gitLeft = cluster([
		branch
			? theme.fg(gitColor, `${glyph(theme, set.branch, gitColor)} ${branch}`)
			: theme.fg("dim", `${glyph(theme, set.branch)} no git`),
		branch ? gitLabel : "",
		state.gitStat.ahead > 0 || state.gitStat.behind > 0
			? theme.fg("success", `↑${state.gitStat.ahead}`) + " " + theme.fg("warning", `↓${state.gitStat.behind}`)
			: "",
	], sep);
	const fileCount = s.files > 0 ? theme.fg("dim", `${glyph(theme, set.file)} ${s.files} touched`) : "";
	const cwd = theme.fg("dim", `${glyph(theme, set.cwd)} ${formatPath(ctx.cwd)}`);
	// A long directory path yields to the branch and working-tree state.
	const gitRight = truncateToWidth(cluster([fileCount, cwd], sep), Math.max(0, width - Math.min(visibleWidth(gitLeft), width - 3) - 3));
	const line3 = alignRow(gitLeft, gitRight, width);

	// Extension statuses get their own row, present only while one is published:
	// workflows first (research, Herder, Loop, processes), then the rest.
	const extensionStatuses = footerData.getExtensionStatuses();
	const workflowKeys = ["autoresearch", "herder", "loop", PROCESS_STATUS_KEY];
	const statusRow = cluster([
		...workflowKeys.map((key): [string, string | undefined] => [key, extensionStatuses.get(key)]),
		...[...extensionStatuses.entries()].filter(([key]) => !workflowKeys.includes(key)),
	].map(([key, status]) => status && renderStatus(theme, status, key, hasNerdFonts())), sep);

	const rule = skin.rule(width);
	const lines = rule ? [line1, rule, line2, line3] : [line1, line2, line3];
	if (statusRow) lines.push(alignRow(statusRow, "", width));
	return lines;
}

// ── extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: Mode = "full";
	let style: Style = "plain";
	let installedCtx: ExtensionContext | undefined;
	let stopWatchingProcesses: (() => void) | undefined;

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
					const skin = skinFor(theme, style);
					return mode === "compact"
						? [renderCompact(ctx, theme, skin, width, state, footerData)]
						: renderFull(ctx, theme, skin, footerData, width, state);
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
		const state = freshSessionState(entry?.type === "custom" ? restoreSnapshot(entry.data) : undefined);
		sessionStates.set(sessionId, state);
		stopWatchingProcesses?.();
		stopWatchingProcesses = watchProcesses(pi.events, (status) => ctx.ui.setStatus(PROCESS_STATUS_KEY, status));
		if (mode !== "off") install(ctx, state);
	});

	// ── streaming metrics collection (TUI session only)

	pi.on("before_provider_request", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		state.serviceTier = extractServiceTier(event.payload);
	});

	pi.on("model_select", (_event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui") return;
		state.serviceTier = undefined;
		state.requestRender?.();
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
		if (!metrics || ctx.mode !== "tui" || metrics.firstTokenAt !== 0) return;
		const update = event.assistantMessageEvent;
		let hasContent = false;
		if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
			hasContent = update.delta.length > 0;
		} else if (update.type === "text_start" || update.type === "thinking_start" || update.type === "toolcall_start") {
			const block = update.partial.content[update.contentIndex];
			hasContent = (block?.type === "text" && block.text.length > 0)
				|| (block?.type === "thinking" && block.thinking.length > 0)
				|| (block?.type === "toolCall" && block.name.length > 0);
		}
		if (!hasContent) return;
		metrics.firstTokenAt = Date.now();
		if (metrics.requestSentAt > 0) {
			metrics.curTtftMs = metrics.firstTokenAt - metrics.requestSentAt;
		}
	});

	pi.on("message_end", (event, ctx) => {
		const state = getSessionState(ctx);
		if (!state || ctx.mode !== "tui" || event.message.role !== "assistant") return;
		const { metrics } = state;
		const { usage, stopReason } = event.message as AssistantMessage;
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
		state.requestRender?.();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopWatchingProcesses?.();
		stopWatchingProcesses = undefined;
		ctx.ui.setStatus(PROCESS_STATUS_KEY, undefined);
		installedCtx = undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessionStates.get(sessionId);
		if (state) {
			state.requestRender = undefined;
			if (event.reason === "reload") {
				pi.appendEntry(RELOAD_ENTRY, {
					metrics: { ...state.metrics, requestSentAt: 0, firstTokenAt: 0, curTtftMs: null },
					serviceTier: state.serviceTier,
				});
			}
		}
		sessionStates.delete(sessionId);
	});

	pi.registerCommand("footer", {
		description: "Statusline footer: /footer [full|compact|off|plain|powerline|debug]",
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
				mode = next;
			} else if (next === "plain" || next === "powerline") {
				// A style applies to the current layout, and turns the footer back on.
				style = next;
				if (mode === "off") mode = "full";
			} else if (next === "") {
				mode = mode === "off" ? "full" : "off";
			} else {
				ctx.ui.notify(
					`Unknown /footer argument '${args.trim()}' — usage: /footer [full|compact|off|plain|powerline|debug]`,
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
				ctx.ui.notify(`Statusline footer: ${mode} mode, ${style} style`, "info");
			}
		},
	});
}
