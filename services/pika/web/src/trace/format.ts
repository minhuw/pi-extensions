/** Elapsed time from a turn's start, `+1:02.3`; an hour or more is `+1:02:03`. */
export function formatElapsed(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	const sign = ms < 0 ? "−" : "+";
	const abs = Math.abs(ms);
	const tenths = Math.floor(abs / 100);
	const totalSeconds = Math.floor(tenths / 10);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${sign}${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${sign}${minutes}:${pad(seconds)}.${tenths % 10}`;
}

/** Clock-style elapsed time for axis ticks: `0:00`, `12:30`, `1:02:00`. */
export function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** A short duration: `840ms`, `3.4s`, `42s`, `1m 05s`, `2h 10m`. */
export function formatSpan(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${pad(minutes)}m`;
	return `${minutes}m ${pad(seconds % 60)}s`;
}

/** An idle gap's label: `47 min`, `2.5 h`, `3 d`. */
export function formatGap(ms: number): string {
	const minutes = ms / 60_000;
	if (minutes < 60) return `${Math.round(minutes)} min`;
	const hours = minutes / 60;
	if (hours < 24) return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)} h`;
	const days = hours / 24;
	return `${days < 10 ? days.toFixed(1).replace(/\.0$/, "") : Math.round(days)} d`;
}

export function formatBytes(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Cuts the middle out of a long string: `/home/me/…/web/src`. */
export function middleTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = max - 1;
	const head = Math.ceil(keep * 0.4);
	return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** Dense cost: `$0.012`, `<$0.001`, `$1.24`; nothing for free calls. */
export function formatFineCost(cost: number | undefined): string {
	if (!cost || !Number.isFinite(cost) || cost <= 0) return "";
	if (cost < 0.001) return "<$0.001";
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/** Wall-clock time, 24-hour: `16:12:09`, or `16:12` without seconds; `—` when unknown. */
export function formatClockTime(at: number | undefined, seconds = true): string {
	if (at === undefined || !Number.isFinite(at)) return "—";
	return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}

/** Date and time for tooltips; `undefined` when unknown, so no `title` is set. */
export function formatInstant(at: number | undefined): string | undefined {
	return at === undefined || !Number.isFinite(at) ? undefined : new Date(at).toLocaleString();
}

/** The span between two instants, if both are known. */
export function spanBetween(start: number | undefined, end: number | undefined): number | undefined {
	return start === undefined || end === undefined ? undefined : end - start;
}

/** A prompt's first line without the markdown marks that read as noise in one line. */
export function plainLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim()) ?? "";
	return line.replace(/\*\*|__|`/g, "").replace(/^#+\s+/, "").trim();
}
