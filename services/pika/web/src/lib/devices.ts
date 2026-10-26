// Helpers for the devices page: pairing codes, device names, and browser descriptions.

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

const DEVICE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The server's rule for device names: 1–64 characters of `[A-Za-z0-9._-]`. */
export function isValidDeviceName(name: string): boolean {
	return DEVICE_NAME.test(name);
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
