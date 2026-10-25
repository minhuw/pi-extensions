import { describe, expect, it, vi } from "vitest";
import { ApiError, PikaApi } from "../src/lib/api";
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

	it("throws ApiError with the status and server error", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
		const api = new PikaApi("/", fetchImpl as unknown as typeof fetch);
		const error = await api.session("missing").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(404);
		expect((error as ApiError).message).toBe("not found");
	});
});
