/**
 * Theme-aware statusline footer for Pi.
 *
 * Visual language is borrowed from pikit's footer: left/right justified rows,
 * a positional RGB gradient context bar, per-level thinking color (rainbow at
 * max/xhigh), and Nerd Font icons with ASCII fallbacks; the identity row is
 * a powerline bar on theme bands. Metrics remain ours: TTFT/TTFB, aggregate
 * throughput, cache ratio, session cost, and working-tree diff.
 *
 * Full mode: identity bar; optional activity/collaboration; performance;
 * resources; workspace. Detail rows share a rail that closes at workspace.
 *    ├ herder: T2 integrate · 3/5 tasks                  📣 rep #dev  ⇌ #ops · 3 in · 2 out
 *    ├ # 13  ⏱ 1h 28m  ❯  tools 42                 ⏱ 4.2s  » 28.9 tok/s
 *    ├ $0.75  $0.06/turn                 ↑ 65k  ↓ 31k  ❮  ~2.4k memory
 *    ╰ ⎇ main  +42 −17                        ▤ 5 touched  ❮  ⌂ ~/…/my-project
 *
 * Compact mode: the bar alone.
 *   ▌✻ model ▶ HIGH ▶ ──────── ◀ ▉▉▉░░░  42%  $1.23  12m ▐
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
import { stripVTControlCharacters } from "node:util";
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
	bar(left: string, right: string, width: number): string;
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

const FLAT_SKIN: Skin = { chrome: 3, bar: alignRow };

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
 * The powerline skin, or the flat skin where the theme cannot carry a band. Pi gives the
 * footer one theme object for the whole session and swaps the theme behind it, so the skin
 * is cached by the sequences it draws with, never by the object.
 */
export function skinFor(theme: Theme): Skin {
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
	"impeccable-live": { placement: "activity", colorSlot: 5, icon: "\u{F03D8}" },
	language: { placement: "language", colorSlot: 6, icon: "\u{F05CA}" },
	spokesman: { placement: "spokesman", colorSlot: 7, icon: "\u{F05CB}" },
	boom: { placement: "mode", colorSlot: 8 },
	alwayson: { placement: "mode", colorSlot: 9 },
	selfdrive: { placement: "mode", colorSlot: 10 },
	representative: { placement: "representative", colorSlot: 11 },
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
	const tone = statusTone(stripVTControlCharacters(text));
	return tone === "problem" ? 3 : tone === "attention" ? 2 : 1;
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

export function renderStatus(theme: Theme, text: string, key = "", withIcon = false): string {
	if (text.includes("\x1b[")) return text;
	const identity = statusHue(theme, key);
	// A status that leads with its own symbol needs no second icon.
	const icon = withIcon && /^[\p{L}\p{N}]/u.test(text)
		? `${theme.fg(identity, STATUS_DESCRIPTORS[key]?.icon ?? STATUS_DEFAULT_ICON)} `
		: "";
	return icon + text.split(/( · |, )/).map((part, index) => {
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

/** Session modes for the bar; each status leads with its own symbol. */
function renderModes(theme: Theme, statuses: ReadonlyMap<string, string>): string | undefined {
	return cluster(statusKeys("mode").map((key) => statuses.get(key) && renderStatus(theme, statuses.get(key)!, key)), "  ") || undefined;
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
	relay: string;
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
	relay: "\u{F028C}", // md-forum
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
	relay: "⇌",
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

interface TierLabel {
	text: string;
	active: boolean;
	observed?: string;
}

/** Prefer the current Magpie switch to the last request's tier. */
function tierLabel(ctx: ExtensionContext, stats: Stats, observedTier?: string): TierLabel | undefined {
	const selected = ctx.model;
	if (selected?.provider === "magpie" && selected.api === "openai-responses") {
		const current = ctx.modelRegistry.getAll().find(model => model.provider === selected.provider && model.id === selected.id) as
			(typeof selected & { magpieServiceTiers?: string[] }) | undefined;
		if (current && current.api === selected.api && current.magpieServiceTiers?.includes("priority")) {
			const observed = displayServiceTier(observedTier);
			return {
				text: stats.magpieFastEnabled ? "FAST" : "FAST OFF",
				active: stats.magpieFastEnabled,
				observed: observed === "FAST" ? undefined : observed,
			};
		}
		// A stale request must not advertise Fast after the catalog removes support.
		if (displayServiceTier(observedTier) === "FAST") return undefined;
	}
	const text = displayServiceTier(observedTier);
	return text ? { text, active: true } : undefined;
}

function renderModelLabel(
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	includeProvider: boolean,
	live = false,
	queued = false,
	tier?: TierLabel,
): string {
	const model = ctx.model;
	const queuedMark = queued && theme.fg("warning", "queued");
	const tierMark = tier && cluster([
		theme.fg(tier.active ? "warning" : "dim", theme.bold(tier.text)),
		tier.observed && theme.fg("warning", theme.bold(tier.observed)),
	], "  ");
	const details = model && modelDetails(ctx, theme, includeProvider);
	const brand = model && modelBrand(model.id, model.provider);
	// A chip carries the live dot and the vendor mark in its own ink.
	const chipColor = skin.chip && ((brand?.color && hexToRgb(brand.color)) || resolveThemeRgb(theme, "accent"));
	if (skin.chip && chipColor) {
		const mark = brand ? `${hasNerdFonts() ? brand.nerd : brand.plain} ` : "";
		return cluster([
			skin.chip(`${live ? "● " : ""}${mark}${model?.id ?? "no-model"}`, chipColor),
			tierMark,
			queuedMark,
			details,
		], "  ");
	}
	const liveMark = live && theme.fg("success", theme.bold("●"));
	const name = model
		? renderModelMark(theme, model.id, model.provider) + theme.fg("accent", theme.bold(model.id))
		: theme.fg("accent", theme.bold("no-model"));
	return cluster([liveMark, queuedMark, name, tierMark, details], "  ");
}

/** Thinking level and provider, each separated by two spaces. */
function modelDetails(ctx: ExtensionContext, theme: Theme, includeProvider: boolean): string {
	const model = ctx.model!;
	return cluster([
		model.reasoning && renderThinking(theme, ctx.thinkingLevel ?? "off"),
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
		const numbers = cluster([compact, percent, counts], "  ");
		const barSpace = maxWidth - visibleWidth(numbers) - 2;
		if (barSpace >= 4) {
			return cluster([compact, gradientBar(pct, Math.min(barWidth, barSpace), theme), percent, counts], "  ");
		}
		// Keep the numerical context when it fits without a bar.
		if (visibleWidth(numbers) <= maxWidth) return numbers;
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
	const tier = tierLabel(ctx, s, state.serviceTier);
	const label = (includeProvider: boolean, showTier = true) => renderModelLabel(
		ctx, theme, skin, includeProvider, !ctx.isIdle(), ctx.hasPendingMessages(), showTier ? tier : undefined,
	);
	let left = label(!compactMode);
	const tail = compactMode ? [
		renderPrice(ctx, s, theme, set),
		theme.fg("dim", fmtDuration(s.durationMs)),
		...(collaborationStatus ? [collaborationStatus] : []),
	] : [];
	const minimumContext = usage?.percent != null ? visibleWidth(`${usage.percent.toFixed(1)}%`) : 0;
	// Compact already renders the provider-free label, so it is the fallback identity too.
	let compactIdentity = compactMode ? left : label(false);
	// The tier is optional: drop it whole before shortening the model or context percentage.
	if (tier && visibleWidth(compactIdentity) + minimumContext + chrome > width) {
		left = label(!compactMode, false);
		compactIdentity = compactMode ? left : label(false, false);
	}
	// The modes outlast every other status: they stay whole while they fit beside the model and context percentage.
	const modes = modeStatus && visibleWidth(compactIdentity) + visibleWidth(modeStatus) + minimumContext + chrome + 2 <= width ? modeStatus : undefined;
	const reserved = modes ? visibleWidth(modes) + 2 : 0;
	const context = renderContext(theme, usage, barWidth, s.compactions, set.compact);
	const right = cluster([modes, context, ...tail], "  ");
	const fitsBeside = (status: string) => visibleWidth(compactIdentity) + visibleWidth(status) + minimumContext + chrome + 2 + reserved <= width;
	const workflow = Array.isArray(workflowStatus) ? fitCompactStatuses(workflowStatus, fitsBeside) : workflowStatus;
	// The spokesman goes first, then the language, each whole; what stays then lays out as if they had never been set.
	const candidates = [
		cluster([workflow, languageStatus, spokesmanStatus], "  "),
		cluster([workflow, languageStatus], "  "),
		workflow ?? "",
	].filter(Boolean);
	const beside = candidates.find(fitsBeside) ?? "";
	if (beside && visibleWidth(left) + visibleWidth(beside) + visibleWidth(right) + chrome + 2 <= width) {
		return skin.bar(cluster([left, beside], "  "), right, width);
	}
	const showBeside = Boolean(beside) && fitsBeside(beside);
	if (!showBeside && visibleWidth(left) + visibleWidth(right) + chrome <= width) return skin.bar(left, right, width);

	// Keep identity and context percent; shed provider, token counts, and compact extras first.
	left = showBeside ? cluster([compactIdentity, beside], "  ") : compactIdentity;
	// A status is optional: never shorten the model or percent to make space for it.
	left = truncateToWidth(left, Math.max(0, width - minimumContext - chrome - reserved));
	const budget = Math.max(0, width - visibleWidth(left) - chrome - reserved);
	while (tail.length && visibleWidth(cluster(tail, "  ")) + 2 + minimumContext > budget) tail.pop();
	const contextBudget = Math.max(0, budget - (tail.length ? visibleWidth(cluster(tail, "  ")) + 2 : 0));
	return skin.bar(left, cluster([
		modes,
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
	const compactKeys = Object.keys(STATUS_DESCRIPTORS).filter(key => STATUS_DESCRIPTORS[key]!.compact && statuses.get(key));
	const workflowKey = compactKeys.find(key => STATUS_DESCRIPTORS[key]!.compact === "workflow");
	const processKey = compactKeys.find(key => STATUS_DESCRIPTORS[key]!.compact === "process");
	const workflow = statuses.get("herder") || statuses.get("goal")
		? compactKeys.map((key, index): CompactStatus => {
			const text = statuses.get(key)!;
			const severity = statusRank(text);
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
				fallbackText: key === "magpie-quota" && severity > 1
					? renderStatus(theme, `quota ${stripVTControlCharacters(text).match(severity === 3 ? STATUS_PROBLEM : STATUS_ATTENTION)![0].trim()}`, key)
					: undefined,
				abbreviate: key === "herder" || key === "goal",
				abbreviateAbove: key === "goal" ? 16 : undefined,
				severityMarker: (key === "herder" || key === "goal") && severity > 1
					? stripVTControlCharacters(text).match(severity === 3 ? STATUS_PROBLEM : STATUS_ATTENTION)?.[0].trim()
					: undefined,
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
		representative && renderStatus(theme, representative, "representative"),
		rooms && `${glyph(theme, icons().relay, "dim")} ${theme.fg("muted", rooms)}`,
	], "  ");
	return renderIdentityRow(ctx, theme, skin, width, state, collectStats(ctx, state), true, renderLanguage(theme, statuses),
		workflow, renderSpokesman(theme, statuses), renderModes(theme, statuses), collaboration);
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

function renderFull(
	ctx: ExtensionContext,
	theme: Theme,
	skin: Skin,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	state: SessionState,
): string[] {
	const s = collectStats(ctx, state);
	const extensionStatuses = footerData.getExtensionStatuses();
	const line1 = renderIdentityRow(
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
		renderModes(theme, extensionStatuses),
	);

	return [line1, ...renderDetailRows(ctx, theme, footerData, width, state, s)];
}

// ── detail rows ────────────────────────────────────────────────────
// Under the bar, activity, performance, resources, and workspace hang from the
// chip on a rail. Facts come in groups split by thin chevrons that echo the
// bar's arrows. Icons carry the hue and values stay muted, unless a value
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

/** Columns a rail row leaves for its groups: alignRow's margins, the rail and its space, and a three-column gap so the sides read apart. */
function railRoom(width: number): number {
	return width - 2 - 2 - 3;
}

/** Columns the thin chevron between two groups takes, with its spacing. */
const RAIL_SEP_WIDTH = 5;

function railRow(theme: Theme, branch: string, left: Group[], right: Group[], width: number): string {
	const nerd = hasNerdFonts();
	const sep = (side: "left" | "right") =>
		`  ${theme.fg("borderMuted", nerd ? (side === "left" ? POWERLINE.thinLeft : POWERLINE.thinRight) : "│")}  `;
	const join = (groups: Group[], side: "left" | "right") => groups.map(group => group.text).join(sep(side));
	const rail = `${theme.fg("borderMuted", branch)} `;
	const room = railRoom(width);
	left = [...left];
	right = [...right];
	while (visibleWidth(join(left, "left")) + visibleWidth(join(right, "right")) > room && left.length + right.length > 1) {
		const weakest = [...left, ...right].reduce((a, b) => (b.rank < a.rank ? b : a));
		if (weakest.statusKey === "goal" && !weakest.severityMarker) {
			const excess = visibleWidth(join(left, "left")) + visibleWidth(join(right, "right")) - room;
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
	return alignRow(rail + join(left, "left"), join(right, "right"), width);
}

function renderDetailRows(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	state: SessionState,
	s: Stats,
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
	const latency = cluster([
		avgTtft != null
			? item(set.ttft, ttftColor(avgTtft), fmtTtft(avgTtft), avgTtft < 2_000 ? "muted" : ttftColor(avgTtft))
				+ (metrics.lastTtftMs != null && metrics.ttftCount > 1 ? theme.fg("dim", ` ${set.last} ${fmtTtft(metrics.lastTtftMs)}`) : "")
			: item(set.ttft, "dim", "—", "dim"),
		metrics.lastTtfbMs != null && item(set.ttfb, "dim", fmtTtft(metrics.lastTtfbMs), "dim"),
		avg != null
			? item(set.speed, "success", fmtTokPerSec(avg))
				+ (metrics.lastTokPerSec != null && metrics.requests > 1 ? theme.fg("dim", ` ${set.last} ${fmtTokPerSec(metrics.lastTokPerSec)}`) : "")
			: item(set.speed, "dim", "—", "dim"),
	], "  ");
	const tools = s.toolCalls > 0
		? cluster([
			item(set.calls, "syntaxFunction", `${s.toolCalls}`),
			s.errors > 0
				? item(set.err, "error", `${s.errors} (${((s.errors / s.toolCalls) * 100).toFixed(1)}%)`, "error")
				: item(set.ok, "success", "0"),
		], "  ")
		: item(set.calls, "dim", "0", "dim");

	const unpriced = s.priceUnavailable || priceUnavailableForModel(ctx);
	// The ASCII cost icon is itself a dollar sign, and the amount already has one.
	const costIcon = (value: string, tone: ThemeToken) =>
		hasNerdFonts() ? item(set.cost, "warning", value, tone) : theme.fg(tone, value);
	const cost = unpriced
		? costIcon("price unavailable", "warning")
		: costIcon(`${s.priceEstimated ? "~" : ""}${fmtCost(s.cost)}`, "text")
			+ (s.turns > 0 ? theme.fg("dim", `  ${fmtCost(s.cost / s.turns)}/turn`) : "");
	const tokens = cluster([
		item(set.input, "toolDiffAdded", fmtTokens(s.input)),
		item(set.output, "toolDiffRemoved", fmtTokens(s.output)),
		s.cacheRead > 0 && item(set.cache, cacheColor, fmtTokens(s.cacheRead))
			+ (cachePct != null ? ` ${theme.fg(cacheColor === "dim" ? "muted" : cacheColor, `${cachePct}%`)}` : ""),
	], "  ");
	const memory = s.memoryTokens > 0 ? theme.fg("dim", `~${fmtTokens(s.memoryTokens)} memory`) : "";
	const think = s.reasoning > 0 ? theme.fg("dim", `${fmtTokens(s.reasoning)} think`) : "";

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
				&& visibleWidth(renderStatus(theme, representative, "representative")) <= railRoom(width)));
	const leftStatuses = activityEntries.map(([key, text], index) => ({
		text: renderStatus(theme, text, key, hasNerdFonts()),
		severityMarker: (key === "herder" || key === "goal") && statusRank(text) > 1
			? stripVTControlCharacters(text).match(statusRank(text) === 3 ? STATUS_PROBLEM : STATUS_ATTENTION)?.[0].trim()
			: undefined,
		statusKey: key,
		rank: statusRank(text) * rankStep + (key === "herder" ? (fittingPeer ? -activityEntries.length : 3) : key === "goal" && statusRank(text) === 1 ? 2 : -index),
	}));
	const relay = cluster([
		additionalRooms(statuses),
		s.relayIn > 0 && `${s.relayIn} in`,
		s.relayOut > 0 && `${s.relayOut} out`,
	], " · ");
	// Collaboration outlasts other routine summaries, while Herder keeps its operation visible.
	const collaboration: Group[] = [
		...(representative ? [{ text: renderStatus(theme, representative, "representative"), rank: statusRank(representative) * rankStep + 1 }] : []),
		...(relay ? [{ text: item(set.relay, "dim", relay), rank: rankStep + 1 }] : []),
	];
	const activityRows = leftStatuses.length || collaboration.length
		? [railRow(theme, "├", leftStatuses, collaboration, width)] : [];
	const performance = railRow(theme, "├", [
		{ text: activity, rank: 3 },
		{ text: tools, rank: 2 },
	], [{ text: latency, rank: 5 }], width);
	const resources = railRow(theme, "├", [{ text: cost, rank: 6 }], [
		{ text: tokens, rank: 4 },
		...(memory ? [{ text: memory, rank: 0 }] : []),
		...(think ? [{ text: think, rank: 1 }] : []),
	], width);

	refreshGitStat(ctx.cwd, state);
	const branch = footerData.getGitBranch();
	const { status, adds, dels, ahead, behind } = state.gitStat;
	const color = gitColor(status);
	const gitState = status === "clean"
		? item(set.ok, "success", "clean")
		: status === "dirty"
			? adds || dels
				? `${theme.fg("toolDiffAdded", `+${adds ?? 0}`)} ${theme.fg("toolDiffRemoved", `−${dels ?? 0}`)}`
				: theme.fg("warning", "dirty")
			: status === "unavailable"
				? theme.fg("error", "git ?")
				: theme.fg("dim", "git …");
	const git = branch
		? cluster([
			`${glyph(theme, set.branch, color)} ${theme.fg("text", branch)}`,
			gitState,
			(ahead > 0 || behind > 0) && `${theme.fg("success", `↑${ahead}`)} ${theme.fg("warning", `↓${behind}`)}`,
		], "  ")
		: item(set.branch, "dim", "no git", "dim");
	const touched = s.files > 0 ? item(set.file, "dim", `${s.files} touched`) : "";
	const pathRoom = railRoom(width) - visibleWidth(git) - visibleWidth(`${set.cwd} `)
		- (touched ? visibleWidth(touched) + RAIL_SEP_WIDTH : 0);
	const cwd = item(set.cwd, "dim", shortenPath(formatPath(ctx.cwd), Math.max(12, pathRoom)));
	const workspace = railRow(theme, "╰", [{ text: git, rank: 4 }], [
		...(touched ? [{ text: touched, rank: 1 }] : []),
		{ text: cwd, rank: 3 },
	], width);
	return [...activityRows, performance, resources, workspace];
}

// ── extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: Mode = "full";
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
					const skin = skinFor(theme);
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
		description: "Statusline footer: /footer [full|compact|off|debug]",
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "footer", kind: "extension", extension: "statusline-footer" });
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
