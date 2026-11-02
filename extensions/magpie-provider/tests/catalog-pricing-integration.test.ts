import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MODELS_DEV_URL } from "../catalog-pricing.ts";
import { createMagpieProvider, discoverModels, readConfig } from "../index.ts";
import { priceCatalog } from "./helpers/price-catalog.ts";

let directory: string;
const config = readConfig({ MAGPIE_BASE_URL: "https://gateway.example", MAGPIE_API_KEY: "secret-gateway-key" });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "magpie-price-discovery-")); vi.stubEnv("PI_CODING_AGENT_DIR", directory); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
function gateway() { return { data: [{ id: "wrong/nested/k3.1-pro", owned_by: "anthropic", native_endpoints: ["/v1/responses"] }] }; }
it("discovers gateway models, resolves live public prices, and calculates recorded usage costs", async () => {
	const calls: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
		calls.push(url);
		if (url === `${config.origin}/v1/models`) {
			expect(init.headers).toEqual({ Authorization: "Bearer secret-gateway-key" }); return Response.json(gateway());
		}
		expect(url).toBe(MODELS_DEV_URL); expect(init.headers).toBeUndefined(); expect(init.credentials).toBe("omit");
		return Response.json(priceCatalog());
	}));
	const [model] = await discoverModels(config);
	expect(model).toMatchObject({ id: "wrong/nested/k3.1-pro", api: "openai-responses", provider: "magpie", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2, magpiePricing: "estimate" } });
	const usage = { input: 1000, output: 100, cacheRead: 500, cacheWrite: 100, totalTokens: 1700,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	expect(calculateCost(model, usage).total).toBeCloseTo(0.0033);
	await discoverModels(config);
	expect(calls).toEqual([`${config.origin}/v1/models`, MODELS_DEV_URL, `${config.origin}/v1/models`]);
});
it("retains usable models on optional price failure, using bundled prices only for absent names", async () => {
	const data = { data: [{ id: "gpt-4.1" }, { id: "new-model" }] };
	vi.stubGlobal("fetch", vi.fn(async (url: string) => url === MODELS_DEV_URL ? new Response(null, { status: 503 }) : Response.json(data)));
	let models = await discoverModels(config);
	expect(models[0].cost.input).toBeGreaterThan(0); expect(models[1].cost).toMatchObject({ magpiePricing: "unavailable" });
	vi.stubGlobal("fetch", vi.fn(async (url: string) => url === MODELS_DEV_URL ? Response.json({
		a: { models: { "gpt-4.1": { id: "gpt-4.1", name: "A", cost: { input: 1, output: 2 } } } },
		b: { models: { "gpt-4.1": { id: "gpt-4.1", name: "A", cost: { input: 3, output: 4 } } } },
	}) : Response.json(data)));
	models = await discoverModels(config);
	expect(models[0].cost).toMatchObject({ magpiePricing: "unavailable" });
});
it("validates the gateway before fetching prices and skips public prices during login and offline refresh", async () => {
	const fetch = vi.fn(async () => Response.json({ data: [] })); vi.stubGlobal("fetch", fetch);
	await expect(discoverModels(config)).rejects.toThrow("no usable"); expect(fetch).toHaveBeenCalledOnce();
	fetch.mockClear(); expect(await discoverModels(config, undefined, true)).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
	fetch.mockImplementation(async () => Response.json(gateway())); fetch.mockClear();
	await discoverModels(config, undefined, true); expect(fetch).toHaveBeenCalledOnce();
	fetch.mockClear();
	await createMagpieProvider({ MAGPIE_BASE_URL: config.origin, MAGPIE_API_KEY: config.apiKey }).refreshModels!({
		allowNetwork: false, signal: new AbortController().signal, publish: async ({ update }) => { update?.(); return true; },
	});
	expect(fetch).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
});
it("does not apply the elapsed gateway timeout to the separate optional price lookup", async () => {
	const timers: AbortController[] = [];
	const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
		const timer = new AbortController(); timers.push(timer); return timer.signal;
	});
	let gatewaySignal: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
		if (url !== MODELS_DEV_URL) { gatewaySignal = init.signal as AbortSignal; return Response.json(gateway()); }
		timers[0].abort();
		expect(gatewaySignal?.aborted).toBe(true); expect(init.signal?.aborted).toBe(false);
		expect(init.signal).not.toBe(gatewaySignal); return Response.json(priceCatalog());
	}));
	expect((await discoverModels(config))[0].cost.input).toBe(2);
	expect(timeout.mock.calls).toEqual([[3000], [3000]]);
});
it("cancels discovery during optional pricing without publishing or persisting the result", async () => {
	const controller = new AbortController();
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (url !== MODELS_DEV_URL) return Response.json(gateway());
		controller.abort(); return Response.json(priceCatalog());
	}));
	const publish = vi.fn(async ({ update }: { update?: () => void }) => { update?.(); return true; });
	const provider = createMagpieProvider({ MAGPIE_BASE_URL: config.origin, MAGPIE_API_KEY: config.apiKey });
	await expect(provider.refreshModels!({ allowNetwork: true, signal: controller.signal, publish })).rejects.toThrow();
	expect(provider.getModels()).toEqual([]); expect(await readdir(directory)).toEqual([]);
});
