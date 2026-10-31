import type { Tokens } from "./types";

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatCount(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "0";
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	if (abs < 1_000_000) return `${trim(n / 1000)}k`;
	if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
	return `${trim(n / 1_000_000_000)}B`;
}

function trim(value: number): string {
	return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

export function totalTokens(tokens: Tokens | null | undefined): number {
	if (!tokens) return 0;
	return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
}

export function formatCost(cost: number | null | undefined): string {
	if (cost === null || cost === undefined || !Number.isFinite(cost) || cost <= 0) return "$0";
	if (cost < 0.01) return "<$0.01";
	if (cost < 100) return `$${cost.toFixed(2)}`;
	return `$${Math.round(cost).toLocaleString("en-US")}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return "—";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "—";
	const seconds = Math.round((time - now) / 1000);
	const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

export function formatDateTime(iso: string | number | null | undefined): string {
	if (iso === null || iso === undefined) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatTime(iso: string | number | null | undefined): string {
	if (iso === null || iso === undefined) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A wait as "N seconds" under a minute, otherwise "N minutes" rounded up. */
export function formatWait(seconds: number): string {
	const s = Math.max(1, Math.ceil(seconds));
	if (s < 60) return s === 1 ? "1 second" : `${s} seconds`;
	const minutes = Math.ceil(s / 60);
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
	return `${formatCount(n)} ${n === 1 ? word : pluralWord}`;
}

export function truncateText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What a cost is the cost of: one record, or a whole session or family. */
export type CostScale = "record" | "session";

/** The upper bounds of the lower three magnitude steps, per scale; everything above the last is the top step. */
export const COST_STEPS: Record<CostScale, [number, number, number]> = {
	record: [0.02, 0.08, 0.25],
	session: [0.5, 2, 8],
};

/** The diameter of each magnitude step, in pixels: the one ramp every view sizes cost with. */
export const COST_DIAMETERS = [4, 6, 8, 10] as const;

/** A cost's step on the fixed four-step magnitude ramp: 0 (nothing or very little) to 3. */
export function costStep(cost: number | null | undefined, scale: CostScale): 0 | 1 | 2 | 3 {
	if (!cost || !Number.isFinite(cost) || cost <= 0) return 0;
	const [a, b, c] = COST_STEPS[scale];
	return cost <= a ? 0 : cost <= b ? 1 : cost <= c ? 2 : 3;
}
