import { describe, expect, it, vi } from "vitest";
import { ApiError, authModeOf, PikaApi } from "../src/lib/api";
import { formatCountdown, isValidDeviceName, normalizePairingCode, shortUserAgent } from "../src/lib/devices";
import { normalizeBase, readBasePath, withBase } from "../src/lib/base";

function okFetch(body: unknown = { items: [] }) {
	return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
}

describe("base path", () => {
	it("normalizes values to a leading slash without a trailing one", () => {
		expect(normalizeBase(undefined)).toBe("/");
		expect(normalizeBase("")).toBe("/");
		expect(normalizeBase("/")).toBe("/");
		expect(normalizeBase("/pika/")).toBe("/pika");
		expect(normalizeBase("pika")).toBe("/pika");
		expect(normalizeBase("/a/b//")).toBe("/a/b");
	});

	it("reads the injected meta tag and defaults to /", () => {
		expect(readBasePath(document)).toBe("/");
		const meta = document.createElement("meta");
		meta.name = "pika-base";
		meta.content = "/pika/";
		document.head.append(meta);
		try {
			expect(readBasePath(document)).toBe("/pika");
		} finally {
			meta.remove();
		}
	});

	it("joins paths under the base", () => {
		expect(withBase("/", "api/v1/facets")).toBe("/api/v1/facets");
		expect(withBase("/pika", "/api/v1/facets")).toBe("/pika/api/v1/facets");
	});
});

describe("PikaApi", () => {
	it("prefixes every read route with the base path", async () => {
		const fetchImpl = okFetch();
		const api = new PikaApi("/pika", fetchImpl as unknown as typeof fetch);
		await api.facets();
		await api.sessions({ device: "mini", root: true }, "c2", 50);
		await api.session("abc/def");
		await api.turns("abc", undefined, 100);
		await api.entries("abc", { from: 3, to: 9, limit: 200 });
		await api.modelRequest("r1");
		await api.herderRuns();
		await api.search({ q: "hello world" });
		const urls = fetchImpl.mock.calls.map(([input]) => String(input));
		expect(urls).toEqual([
			"/pika/api/v1/facets",
			"/pika/api/v1/sessions?device=mini&root=true&cursor=c2&limit=50",
			"/pika/api/v1/sessions/abc%2Fdef",
			"/pika/api/v1/sessions/abc/turns?limit=100",
			"/pika/api/v1/sessions/abc/entries?from=3&to=9&limit=200",
			"/pika/api/v1/requests/r1",
			"/pika/api/v1/herder/runs",
			"/pika/api/v1/search?q=hello+world",
		]);
		expect(api.exportUrl("abc")).toBe("/pika/api/v1/sessions/abc/export");
		expect(api.rawEntryUrl("abc", 4)).toBe("/pika/api/v1/sessions/abc/entries/4/raw");
	});

	it("uses /api/v1 at the root base and omits root=false", async () => {
		const fetchImpl = okFetch();
		const api = new PikaApi("/", fetchImpl as unknown as typeof fetch);
		await api.sessions({ root: false });
		expect(String(fetchImpl.mock.calls[0][0])).toBe("/api/v1/sessions");
	});

	it("sends the login password as JSON and keeps cookies same-origin", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const api = new PikaApi("/pika", fetchImpl as unknown as typeof fetch);
		await api.login("secret");
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/pika/api/v1/login");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("same-origin");
		expect(JSON.parse(String(init.body))).toEqual({ password: "secret" });
	});

	it("sends state-changing device, pairing, and session calls as JSON POSTs or DELETEs", async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
		const api = new PikaApi("/pika", fetchImpl as unknown as typeof fetch);
		await api.me();
		await api.devices();
		await api.pairings();
		await api.browserSessions();
		await api.approvePairing("K7QM-3XRP", { name: "studio", replace: true });
		await api.denyPairing("K7QM-3XRP");
		await api.revokeDevice("my.mac");
		await api.deleteBrowserSession("0123456789ab");
		await api.revokeAllBrowserSessions();
		await api.logout();
		const calls = fetchImpl.mock.calls.map(([input, init]) => ({
			url: String(input),
			method: init?.method ?? "GET",
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			type: (init?.headers as Record<string, string> | undefined)?.["Content-Type"],
		}));
		expect(calls).toEqual([
			{ url: "/pika/api/v1/me", method: "GET", body: undefined, type: undefined },
			{ url: "/pika/api/v1/devices", method: "GET", body: undefined, type: undefined },
			{ url: "/pika/api/v1/pairings", method: "GET", body: undefined, type: undefined },
			{ url: "/pika/api/v1/auth/sessions", method: "GET", body: undefined, type: undefined },
			{ url: "/pika/api/v1/pairings/K7QM-3XRP/approve", method: "POST", body: { name: "studio", replace: true }, type: "application/json" },
			{ url: "/pika/api/v1/pairings/K7QM-3XRP/deny", method: "POST", body: {}, type: "application/json" },
			{ url: "/pika/api/v1/devices/my.mac", method: "DELETE", body: undefined, type: undefined },
			{ url: "/pika/api/v1/auth/sessions/0123456789ab", method: "DELETE", body: undefined, type: undefined },
			{ url: "/pika/api/v1/auth/sessions/revoke-all", method: "POST", body: {}, type: "application/json" },
			{ url: "/pika/api/v1/logout", method: "POST", body: {}, type: "application/json" },
		]);
	});

	it("reads a 429's wait from the body, or from Retry-After", async () => {
		const limited = (body: unknown, headers: Record<string, string> = {}) =>
			new PikaApi("/", (async () => new Response(JSON.stringify(body), { status: 429, headers })) as typeof fetch);
		const fromBody = await limited({ error: "too_many_attempts", retryAfter: 120 }).login("x").catch((e: unknown) => e);
		expect(fromBody).toBeInstanceOf(ApiError);
		expect((fromBody as ApiError).message).toBe("too_many_attempts");
		expect((fromBody as ApiError).retryAfter).toBe(120);
		const fromHeader = await limited({ error: "too_many_attempts" }, { "Retry-After": "30" }).login("x").catch((e: unknown) => e);
		expect((fromHeader as ApiError).retryAfter).toBe(30);
	});

	it("derives the auth mode for servers that predate it", () => {
		expect(authModeOf({ authenticated: true, passwordRequired: false, authMode: "proxy" })).toBe("proxy");
		expect(authModeOf({ authenticated: false, passwordRequired: true })).toBe("password");
		expect(authModeOf({ authenticated: true, passwordRequired: false })).toBe("none");
		expect(authModeOf(undefined)).toBeUndefined();
	});

	it("throws ApiError with the status and server error", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
		const api = new PikaApi("/", fetchImpl as unknown as typeof fetch);
		const error = await api.session("missing").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(404);
		expect((error as ApiError).message).toBe("not found");
	});
});

describe("device helpers", () => {
	it("matches pairing codes case-insensitively, with or without the hyphen", () => {
		expect(normalizePairingCode("k7qm-3xrp")).toBe("K7QM3XRP");
		expect(normalizePairingCode("K7QM3XRP")).toBe("K7QM3XRP");
		expect(normalizePairingCode(" k7qm 3xrp ")).toBe("K7QM3XRP");
	});

	it("checks device names like the server", () => {
		expect(isValidDeviceName("mini.lan_2-a")).toBe(true);
		expect(isValidDeviceName("")).toBe(false);
		expect(isValidDeviceName("my mac")).toBe(false);
		expect(isValidDeviceName("x".repeat(64))).toBe(true);
		expect(isValidDeviceName("x".repeat(65))).toBe(false);
	});

	it("formats countdowns as m:ss", () => {
		expect(formatCountdown(600_000)).toBe("10:00");
		expect(formatCountdown(61_500)).toBe("1:02");
		expect(formatCountdown(-5)).toBe("0:00");
	});

	it("shortens user agents", () => {
		expect(shortUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe(
			"Chrome 141 on macOS",
		);
		expect(
			shortUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"),
		).toBe("Edge 141 on Windows");
		expect(
			shortUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"),
		).toBe("Safari 18 on iOS");
		expect(shortUserAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36")).toBe(
			"Chrome 141 on Android",
		);
		expect(shortUserAgent("curl/8.7.1")).toBe("curl 8");
		expect(shortUserAgent(undefined)).toBe("Unknown browser");
		expect(shortUserAgent("x".repeat(80))).toHaveLength(48);
	});
});
