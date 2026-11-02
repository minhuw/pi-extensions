import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelCost } from "@earendil-works/pi-ai";
import { magpieModelName } from "./model-identity.ts";
import type { MagpieCost } from "./pricing.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
export const PRICING_TIMEOUT_MS = 3000;
export const PRICING_MAX_BYTES = 16 * 1024 * 1024;
export type CatalogPricingResolver = (id: string) => MagpieCost | undefined;
type Prices = Record<string, ModelCost | null>;
const unavailable: MagpieCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, magpiePricing: "unavailable" };
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rate(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid price");
	return value;
}
function rates(value: unknown): ModelCost {
	if (!object(value)) throw new Error("Invalid rates");
	return { input: rate(value.input), output: rate(value.output), cacheRead: value.cache_read === undefined ? 0 : rate(value.cache_read),
		cacheWrite: value.cache_write === undefined ? 0 : rate(value.cache_write) };
}
function catalogCost(value: unknown): ModelCost | null {
	try {
		const base = rates(value);
		if (!object(value)) return null;
		if (value.context_over_200k !== undefined) rates(value.context_over_200k);
		if (value.tiers !== undefined) {
			if (!Array.isArray(value.tiers)) return null;
			base.tiers = value.tiers.map(entry => {
				if (!object(entry) || !object(entry.tier) || entry.tier.type !== "context"
					|| !Number.isSafeInteger(entry.tier.size) || (entry.tier.size as number) <= 0) throw new Error("Unsupported tier");
				return { ...rates(entry), inputTokensAbove: entry.tier.size as number };
			}).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
			if (base.tiers.some((tier, index) => index > 0 && tier.inputTokensAbove === base.tiers![index - 1].inputTokensAbove)) return null;
		} else if (value.context_over_200k !== undefined) {
			base.tiers = [{ ...rates(value.context_over_200k), inputTokensAbove: 200000 }];
		}
		if (!base.tiers?.length) delete base.tiers;
		return base;
	} catch { return null; }
}
/** Choose the most common published token rates, excluding plan zeros when paid rates exist. */
function commonCost(costs: (ModelCost | null)[]): ModelCost | null {
	const valid = costs.filter((cost): cost is ModelCost => cost !== null);
	const paid = valid.filter(cost => [cost, ...(cost.tiers ?? [])]
		.some(rates => rates.input || rates.output || rates.cacheRead || rates.cacheWrite));
	if (!paid.length && valid.length !== costs.length) return null;
	const votes = new Map<string, { cost: ModelCost; count: number }>();
	for (const cost of paid.length ? paid : valid) {
		const key = JSON.stringify(cost);
		const vote = votes.get(key) ?? { cost, count: 0 };
		vote.count++;
		votes.set(key, vote);
	}
	const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
	return ranked.length && ranked[0].count > (ranked[1]?.count ?? 0) ? ranked[0].cost : null;
}

/** Index only model names. Equal display names connect different advertised model IDs. */
export function modelsDevPrices(value: unknown): Prices {
	if (!object(value)) throw new Error("Invalid catalog");
	const byDisplayName = new Map<string, (ModelCost | null)[]>();
	const modelNames = new Map<string, Set<string>>();
	for (const data of Object.values(value)) {
		if (!object(data) || !object(data.models)) throw new Error("Invalid provider");
		for (const [id, row] of Object.entries(data.models)) {
			if (!object(row) || row.id !== id || typeof row.name !== "string" || !row.name) throw new Error("Invalid model");
			const name = magpieModelName(id);
			if (!name) continue;
			const costs = byDisplayName.get(row.name) ?? [];
			costs.push(catalogCost(row.cost));
			byDisplayName.set(row.name, costs);
			const displays = modelNames.get(name) ?? new Set<string>();
			displays.add(row.name);
			modelNames.set(name, displays);
		}
	}
	const prices: Prices = Object.create(null);
	for (const [name, displays] of modelNames) {
		prices[name] = commonCost([...displays].flatMap(display => byDisplayName.get(display)!));
	}
	return prices;
}
function resolver(prices: Prices): CatalogPricingResolver {
	return id => {
		const name = magpieModelName(id);
		if (!name || !Object.hasOwn(prices, name)) return undefined;
		return prices[name] ? { ...structuredClone(prices[name]), magpiePricing: "estimate" } : { ...unavailable };
	};
}
export function createModelsDevPricingResolver(value: unknown): CatalogPricingResolver {
	return resolver(modelsDevPrices(value));
}
interface Snapshot { version: 2; fetchedAt: number; prices: Prices }
function snapshot(value: unknown): Snapshot {
	if (!object(value) || value.version !== 2 || typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)
		|| value.fetchedAt < 0 || value.fetchedAt > Date.now() || !object(value.prices)) throw new Error("Invalid snapshot");
	const prices: Prices = Object.create(null);
	for (const [name, cost] of Object.entries(value.prices)) {
		if (magpieModelName(name) !== name) throw new Error("Invalid name");
		if (cost === null) { prices[name] = null; continue; }
		if (!object(cost)) throw new Error("Invalid cost");
		const base = { input: rate(cost.input), output: rate(cost.output), cacheRead: rate(cost.cacheRead), cacheWrite: rate(cost.cacheWrite) };
		const normalized = catalogCost({ input: base.input, output: base.output, cache_read: base.cacheRead, cache_write: base.cacheWrite,
			...(cost.tiers === undefined ? {} : { tiers: Array.isArray(cost.tiers) ? cost.tiers.map(tier => object(tier) ? {
				input: tier.input, output: tier.output, cache_read: tier.cacheRead, cache_write: tier.cacheWrite,
				tier: { type: "context", size: tier.inputTokensAbove },
			} : null) : null }) });
		if (!normalized) throw new Error("Invalid tier cost");
		prices[name] = normalized;
	}
	return { version: 2, fetchedAt: value.fetchedAt, prices };
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
	if (Number(response.headers.get("content-length")) > PRICING_MAX_BYTES) {
		void response.body?.cancel().catch(() => {});
		throw new Error("Catalog too large");
	}
	if (!response.body) throw new Error("Missing catalog body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await abortable(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > PRICING_MAX_BYTES) throw new Error("Catalog too large");
			chunks.push(value);
		}
		signal.throwIfAborted();
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function persist(path: string, value: Snapshot, signal?: AbortSignal): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); }
		signal?.throwIfAborted();
		await rename(temporary, path);
	} finally { await unlink(temporary).catch(() => {}); }
}

/** Optional unauthenticated lookup; caller cancellation is distinct from pricing source failure. */
export async function loadModelsDevPricing(signal?: AbortSignal, agentDir = getAgentDir()): Promise<CatalogPricingResolver | undefined> {
	signal?.throwIfAborted();
	const path = join(agentDir, "magpie-prices.json");
	let cached: Snapshot | undefined;
	try {
		const file = await open(path, "r");
		try {
			if ((await file.stat()).size > PRICING_MAX_BYTES) throw new Error("Cache too large");
			cached = snapshot(JSON.parse(await file.readFile("utf8")));
		} finally { await file.close(); }
	} catch { /* Missing or corrupt cache is optional. */ }
	signal?.throwIfAborted();
	if (cached && Date.now() - cached.fetchedAt < PRICING_TTL_MS) return resolver(cached.prices);
	const bounded = AbortSignal.any([AbortSignal.timeout(PRICING_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	try {
		const response = await abortable(fetch(MODELS_DEV_URL, { signal: bounded, redirect: "error", credentials: "omit" }), bounded);
		if (!response.ok) throw new Error("Price source unavailable");
		const prices = modelsDevPrices(await readBounded(response, bounded));
		if (!Object.keys(prices).length) throw new Error("Empty price catalog");
		bounded.throwIfAborted();
		const fresh: Snapshot = { version: 2, fetchedAt: Date.now(), prices };
		try { await mkdir(agentDir, { recursive: true }); await persist(path, fresh, signal); } catch { /* Persistence is best effort. */ }
		signal?.throwIfAborted();
		return resolver(prices);
	} catch {
		signal?.throwIfAborted();
		return cached ? resolver(cached.prices) : undefined;
	}
}
