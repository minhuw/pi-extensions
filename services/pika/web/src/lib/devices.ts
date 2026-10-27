// Helpers for devices: pairing codes, device names and labels, and browser descriptions.

/** Pairing codes match case-insensitively, with or without the hyphen. */
export function normalizePairingCode(code: string): string {
	return code.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The order pending requests show in: the deep-linked one (`wanted`, normalized) pinned first, then the others oldest
 * first, so a request that arrives later appends below instead of pushing the one the user is checking down.
 */
export function orderPairings<T extends { code: string; requestedAt: string }>(
	items: readonly T[],
	wanted: string | null,
): { pinned: T | undefined; others: T[] } {
	const sorted = [...items].sort(
		(a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || a.code.localeCompare(b.code),
	);
	const pinned = wanted === null ? undefined : sorted.find((item) => normalizePairingCode(item.code) === wanted);
	return { pinned, others: sorted.filter((item) => item !== pinned) };
}

export const DEVICE_NAME_MAX = 64;

// Control characters (Cc, which includes U+0085), the line and paragraph separators, and lone surrogates, which are
// not Unicode scalar values and so cannot be sent.
const NAME_FORBIDDEN = /[\p{Cc}\u2028\u2029\p{Cs}]/u;

export const DEVICE_NAME_RULE = "Use 1-64 characters, without control characters.";

/**
 * The server's rule for device names: after trimming whitespace at both ends, 1–64 characters (code points, not
 * UTF-16 units or bytes), none of them control characters or U+2028/U+2029.
 */
export function isValidDeviceName(name: string): boolean {
	const trimmed = name.trim();
	const length = [...trimmed].length;
	return length >= 1 && length <= DEVICE_NAME_MAX && !NAME_FORBIDDEN.test(trimmed);
}

/** What to call a device: its name, or its id when the server sent none (servers older than 0.4). */
export function deviceLabel(item: { device: string; deviceName?: string | null }): string {
	return item.deviceName || item.device;
}

/**
 * Filter options for devices: the id as value, the name as label, with the first 8 characters of the id appended in
 * parentheses when two devices share a name.
 */
export function deviceOptions(devices: readonly { id: string; name: string }[]): { value: string; label: string }[] {
	const counts = new Map<string, number>();
	for (const item of devices) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
	return devices.map((item) => ({
		value: item.id,
		label: (counts.get(item.name) ?? 0) > 1 ? `${item.name} (${item.id.slice(0, 8)})` : item.name || item.id,
	}));
}

/** Time left as `m:ss`, never below zero. */
export function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const BROWSERS: [RegExp, string][] = [
	[/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
	[/OPR\/(\d+)/, "Opera"],
	[/Firefox\/(\d+)/, "Firefox"],
	[/FxiOS\/(\d+)/, "Firefox"],
	[/CriOS\/(\d+)/, "Chrome"],
	[/Chrome\/(\d+)/, "Chrome"],
	[/Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari\//, "Safari"],
	[/^curl\/(\d+)/, "curl"],
];

const SYSTEMS: [RegExp, string][] = [
	[/iPhone|iPad|iPod/, "iOS"],
	[/Android/, "Android"],
	[/CrOS/, "ChromeOS"],
	[/Mac OS X|Macintosh/, "macOS"],
	[/Windows/, "Windows"],
	[/Linux/, "Linux"],
];

/** "Firefox 131 on Linux" for a user agent string; the string itself, cut short, when unrecognized. */
export function shortUserAgent(ua: string | null | undefined): string {
	if (!ua) return "Unknown browser";
	const browser = BROWSERS.map(([pattern, label]) => {
		const match = pattern.exec(ua);
		return match ? `${label} ${match[1]}` : undefined;
	}).find(Boolean);
	const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
	if (browser && system) return `${browser} on ${system}`;
	if (browser) return browser;
	return ua.length > 48 ? `${ua.slice(0, 47)}…` : ua;
}
