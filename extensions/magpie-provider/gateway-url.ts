export type MagpieGatewayOriginResult =
	| { ok: true; url: URL; origin: string }
	| { ok: false; reason: "invalid-url" }
	| { ok: false; reason: "unsafe-origin"; url: URL }
	| { ok: false; reason: "invalid-path"; url: URL };

export function parseMagpieGatewayOrigin(
	input: string,
	options: { allowV1: boolean },
): MagpieGatewayOriginResult {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return { ok: false, reason: "invalid-url" };
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.href.includes("?") ||
		url.href.includes("#")
	) {
		return { ok: false, reason: "unsafe-origin", url };
	}
	const validPath = options.allowV1 ? /^\/(?:v1\/?)?$/.test(url.pathname) : url.pathname === "/";
	if (!validPath) {
		return { ok: false, reason: "invalid-path", url };
	}
	return { ok: true, url, origin: url.origin };
}
