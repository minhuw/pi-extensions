import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createModelsDevPricingResolver, loadModelsDevPricing, MODELS_DEV_URL, modelsDevPrices, PRICING_MAX_BYTES, PRICING_TTL_MS } from "../catalog-pricing.ts";
import { priceCatalog } from "./helpers/price-catalog.ts";

const regular = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2, magpiePricing: "estimate" };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "magpie-prices-")); });
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
function http(value: unknown = priceCatalog()) {
	const fetch = vi.fn(async () => Response.json(value));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
async function cache(stale = false) {
	await writeFile(join(directory, "magpie-prices.json"), JSON.stringify({ version: 2, fetchedAt: Date.now() - (stale ? PRICING_TTL_MS + 1000 : 1000), prices: modelsDevPrices(priceCatalog()) }));
}
it("matches model names and display-name aliases regardless of route prefixes or provider metadata", () => {
	const resolve = createModelsDevPricingResolver(priceCatalog());
	for (const prefix of ["", "anthropic/", "codex/", "unknown/nested/group/"]) {
		for (const name of ["kimi-k3.1-pro", "k3.1-pro"]) expect(resolve(prefix + name)).toEqual(regular);
		for (const name of ["kimi-k3.1-pro-highspeed", "k3.1-pro-highspeed"]) {
			expect(resolve(prefix + name)).toEqual({ ...regular, input: 4, output: 20, cacheWrite: 4 });
		}
	}
	expect(resolve("unfamiliar")).toMatchObject({ input: 7, output: 9, cacheRead: 0, cacheWrite: 0 });
	for (const name of ["Kimi-k3.1-pro", "k3.1", "k3.1-pro@500k", "k3.1-pro-fast", "k3.1-pro-20260101", "k3.1-pro "]) expect(resolve(name)).toBeUndefined();
	const cost = resolve("k3.1-pro")!; cost.input = 99;
	expect(resolve("k3.1-pro")).toEqual(regular);
});
it("preserves explicit thresholds, authoritative tiers, and legacy context rates", () => {
	const value: any = priceCatalog();
	delete value.another; delete value.reseller;
	const cost = value.moonshotai.models["kimi-k3.1-pro"].cost;
	cost.tiers = [{ input: 5, output: 25, tier: { type: "context", size: 272000 } }];
	cost.context_over_200k = { input: 99, output: 99 };
	expect(createModelsDevPricingResolver(value)("k3.1-pro")?.tiers).toEqual([{ input: 5, output: 25, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 272000 }]);
	delete cost.tiers;
	expect(createModelsDevPricingResolver(value)("k3.1-pro")?.tiers?.[0].inputTokensAbove).toBe(200000);
});
it.each([
	{ input: -1, output: 1 }, { input: NaN, output: 1 }, { input: 1, output: Infinity }, { input: "2", output: 1 },
	{ input: 1, output: 1, cache_read: -1 }, { input: 1, output: 1, cache_write: null },
	{ input: 1, output: 1, tiers: [{ input: 1, output: 1, tier: { type: "time", size: 100 } }] },
	{ input: 1, output: 1, tiers: [{ input: 1, output: 1, tier: { type: "context", size: 0 } }] },
	{ input: 1, output: 1, tiers: [{ input: 1, output: 1, tier: { type: "context", size: 1.2 } }] },
	{ input: 1, output: 1, tiers: [{ input: 1, output: 1, cache_read: Infinity, tier: { type: "context", size: 100 } }] },
	{ input: 1, output: 1, tiers: [{ input: 1, output: 1, tier: { type: "context", size: 100 } }, { input: 2, output: 2, tier: { type: "context", size: 100 } }] },
	{ input: 1, output: 1, context_over_200k: { input: 2 } },
])("leaves invalid prices and unsupported tiers unavailable: %j", cost => {
	const value: any = priceCatalog();
	delete value.another; delete value.reseller;
	value.moonshotai.models["kimi-k3.1-pro"].cost = cost;
	expect(createModelsDevPricingResolver(value)("k3.1-pro")?.magpiePricing).toBe("unavailable");
});
it("chooses the most common paid rates, leaving ties unavailable regardless of catalog order", () => {
	const a = { models: { duplicate: { id: "duplicate", name: "Duplicate", cost: { input: 1, output: 2 } } } };
	const b = structuredClone(a); b.models.duplicate.cost.input = 2;
	const c = structuredClone(b);
	const plan = structuredClone(a); plan.models.duplicate.cost = { input: 0, output: 0 };
	for (const value of [{ a, b }, { b, a }]) {
		expect(createModelsDevPricingResolver(value)("duplicate")?.magpiePricing).toBe("unavailable");
	}
	for (const value of [{ a, b, c, plan }, { plan, c, b, a }]) {
		expect(createModelsDevPricingResolver(value)("duplicate")).toMatchObject({ input: 2, output: 2, magpiePricing: "estimate" });
	}
	expect(createModelsDevPricingResolver({ plan })("duplicate")).toMatchObject({ input: 0, output: 0, magpiePricing: "estimate" });
});
it("uses only names even when providers are renamed and canonical metadata is absent or misleading", () => {
	const value: any = priceCatalog();
	value.moonshotai.models["kimi-k3.1-pro-highspeed"].canonical_model_id = "irrelevant/regular";
	value["coding-plan"].models["k3.1-pro"].canonical_model_id = { malformed: true };
	const renamed = Object.fromEntries(Object.values(value).map((data, i) => [`unknown-${i}`, data]));
	expect(modelsDevPrices(renamed)).toEqual(modelsDevPrices(priceCatalog()));
});
it("fetches without gateway credentials, persists only prices atomically, and reuses fresh disk cache", async () => {
	const fetch = http();
	expect((await loadModelsDevPricing(undefined, directory))!("x/k3.1-pro")).toEqual(regular);
	expect(fetch).toHaveBeenCalledExactlyOnceWith(MODELS_DEV_URL, { signal: expect.any(AbortSignal), redirect: "error", credentials: "omit" });
	const saved = JSON.parse(await readFile(join(directory, "magpie-prices.json"), "utf8"));
	expect(saved).toEqual({ version: 2, fetchedAt: expect.any(Number), prices: modelsDevPrices(priceCatalog()) });
	expect(await readdir(directory)).toEqual(["magpie-prices.json"]);
	expect((await loadModelsDevPricing(undefined, directory))!("k3.1-pro")).toEqual(regular);
	expect(fetch).toHaveBeenCalledOnce();
});
it.each(["network", "http", "json", "validation", "empty", "header-cap", "body-cap"])("uses stale validated cache after %s failure", async mode => {
	await cache(true);
	vi.stubGlobal("fetch", vi.fn(async () => {
		if (mode === "network") throw new Error("offline");
		if (mode === "http") return new Response(null, { status: 503 });
		if (mode === "json") return new Response("{");
		if (mode === "validation") return Response.json({ providers: {} });
		if (mode === "empty") return Response.json({});
		if (mode === "header-cap") return new Response("{}", { headers: { "content-length": String(PRICING_MAX_BYTES + 1) } });
		return new Response(new Uint8Array(PRICING_MAX_BYTES + 1));
	}));
	const original = await readFile(join(directory, "magpie-prices.json"), "utf8");
	expect((await loadModelsDevPricing(undefined, directory))!("k3.1-pro")).toEqual(regular);
	expect(await readFile(join(directory, "magpie-prices.json"), "utf8")).toBe(original);
});
it.each(["{", '{"version":2,"fetchedAt":1,"prices":{"bad":{"input":-1}}}', '{"version":1,"fetchedAt":1,"prices":{}}'])("ignores corrupt cache %s and replaces it", async content => {
	await writeFile(join(directory, "magpie-prices.json"), content); http();
	expect((await loadModelsDevPricing(undefined, directory))!("k3.1-pro")).toEqual(regular);
	expect(JSON.parse(await readFile(join(directory, "magpie-prices.json"), "utf8")).version).toBe(2);
});
it.each(["headers", "body"])("bounds a stalled %s request and retains stale pricing", async mode => {
	await cache(true);
	vi.stubGlobal("fetch", vi.fn(() => mode === "headers" ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream({ start() {} })))));
	expect((await loadModelsDevPricing(undefined, directory))!("k3.1-pro")).toEqual(regular);
}, 5000);
it("returns no source without usable cache when offline, and tolerates unwritable persistence", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
	expect(await loadModelsDevPricing(undefined, directory)).toBeUndefined();
	const file = join(directory, "not-a-directory"); await writeFile(file, "fixture"); http();
	expect((await loadModelsDevPricing(undefined, file))!("k3.1-pro")).toEqual(regular);
});
it("honors pre-existing and in-flight caller cancellation without writing a snapshot", async () => {
	const controller = new AbortController(); const fetch = http(); controller.abort();
	await expect(loadModelsDevPricing(controller.signal, directory)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
	const active = new AbortController();
	vi.stubGlobal("fetch", vi.fn(async () => { active.abort(); return Response.json(priceCatalog()); }));
	await expect(loadModelsDevPricing(active.signal, directory)).rejects.toThrow();
	expect(await readdir(directory)).toEqual([]);
});

it("cleans up the temporary snapshot when atomic rename fails", async () => {
	await mkdir(join(directory, "magpie-prices.json")); http();
	expect((await loadModelsDevPricing(undefined, directory))!("k3.1-pro")).toEqual(regular);
	expect(await readdir(directory)).toEqual(["magpie-prices.json"]);
	expect(await readdir(join(directory, "magpie-prices.json"))).toEqual([]);
});
