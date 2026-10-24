import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type Model, type ModelCost, type Provider, type Usage } from "@earendil-works/pi-ai";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { parseModels } from "../index.ts";
import { magpieModelName } from "../model-identity.ts";
import { createMagpiePricingResolver, withMagpiePricing } from "../pricing.ts";
import { usageFromResponse } from "../native-compaction/native-compaction.ts";

const rates: ModelCost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
	tiers: [{ inputTokensAbove: 200000, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }] };
const unavailable = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, magpiePricing: "unavailable" };
function catalog(provider: string, id: string, cost = rates): Pick<Provider, "id" | "getModels"> {
	return { id: provider, getModels: () => [{ id, provider, cost } as Model<any>] };
}

it("prices exact model names across bare, known, unknown, mismatched, group, and nested gateway prefixes", () => {
	const resolve = createMagpiePricingResolver([
		catalog("openai", "gpt-fixture"), catalog("anthropic", "claude-fixture"),
		catalog("deepseek", "deepseek-fixture"), catalog("xai", "grok-fixture"),
	]);
	for (const name of ["gpt-fixture", "claude-fixture", "deepseek-fixture", "grok-fixture"]) {
		for (const prefix of ["", "openai/", "codex/", "auto/", "mercerrouter/", "anthropic/", "deepseek/",
			"grok/", "xai/", "unknown-vendor/", "group/", "gateway/nested/group/"]) {
			expect(resolve(`${prefix}${name}`)).toEqual({ ...rates, magpiePricing: "estimate" });
		}
	}
});

it("deep clones base, cache, and tier prices for each resolution", () => {
	const source = structuredClone(rates);
	const resolve = createMagpiePricingResolver([catalog("openai", "gpt-fixture", source)]);
	const cost = resolve("group/gpt-fixture");
	cost.input = 999;
	cost.cacheRead = 999;
	cost.tiers![0].input = 999;
	cost.tiers![0].cacheWrite = 999;
	cost.tiers!.push({ ...cost.tiers![0], inputTokensAbove: 900000 });
	expect(source).toEqual(rates);
	expect(resolve("gpt-fixture")).toEqual({ ...rates, magpiePricing: "estimate" });
});

it("normalizes canonical catalog IDs with the same exact final-segment rule", () => {
	const resolve = createMagpiePricingResolver([
		catalog("anthropic", "canonical/nested/Unexpected.Model@500k-build-fast"),
	]);
	for (const id of ["Unexpected.Model@500k-build-fast", "unknown/Unexpected.Model@500k-build-fast"]) {
		expect(magpieModelName(id)).toBe("Unexpected.Model@500k-build-fast");
		expect(resolve(id)).toEqual({ ...rates, magpiePricing: "estimate" });
	}
	for (const id of ["Unexpected.Model", "unexpected.model@500k-build-fast", "Unexpected.Model@500k"]) {
		expect(resolve(id)).toEqual(unavailable);
	}
});

it.each(["gpt-fixture-new", "gpt-fixture@500k", "gpt-fixture-build-fast", "GPT-fixture", "gpt",
	"unknown/claude-fixture-v2", "group/grok-fixture@500k"])("leaves exact unmatched name %s unpriced", id => {
	const resolve = createMagpiePricingResolver([
		catalog("openai", "gpt-fixture"), catalog("xai", "grok-fixture"), catalog("anthropic", "claude-fixture"),
	]);
	expect(resolve(id)).toEqual(unavailable);
});

const invalidIds = ["", "/gpt-fixture", "gateway/", "gateway//gpt-fixture", "//gpt-fixture", "/",
	" gpt-fixture", "gpt-fixture ", "gate way/gpt-fixture", "gateway/gpt-fixture\n", "gateway\t/gpt-fixture",
	"gateway/\u0000gpt-fixture", "gateway/\u001fgpt-fixture", "gateway\u007f/gpt-fixture", "gateway\u0085/gpt-fixture",
	"gateway/\u00a0gpt-fixture", "gate*/gpt-fixture", "gate?/gpt-fixture", "gate[ab]/gpt-fixture",
	"gate{a,b}/gpt-fixture", "gateway/gpt-fixture*", "gateway/gpt-fixture?", "gateway/gpt-fixture[",
	"gateway/gpt-fixture]", "gateway/gpt-fixture{", "gateway/gpt-fixture}"];
it.each(invalidIds)("rejects malformed query ID %j", id => {
	const resolve = createMagpiePricingResolver([catalog("openai", "gpt-fixture")]);
	expect(magpieModelName(id)).toBeUndefined();
	expect(resolve(id)).toEqual(unavailable);
});

it.each(invalidIds)("ignores malformed canonical catalog ID %j", id => {
	const resolve = createMagpiePricingResolver([catalog("openai", id)]);
	expect(resolve("gpt-fixture")).toEqual(unavailable);
});

it("reads only the four canonical upstream providers, without inferring model families", () => {
	const resolve = createMagpiePricingResolver([
		catalog("openai", "unfamiliar-name"), catalog("anthropic", "gpt-fixture"),
		catalog("codex", "excluded-codex"), catalog("grok", "excluded-grok"),
		catalog("openrouter", "excluded-openrouter"), catalog("unknown", "excluded-unknown"),
		catalog("openrouter", "unfamiliar-name", { ...rates, output: 99 }),
	]);
	expect(resolve("grok/unfamiliar-name")).toEqual({ ...rates, magpiePricing: "estimate" });
	expect(resolve("anthropic/gpt-fixture")).toEqual({ ...rates, magpiePricing: "estimate" });
	for (const id of ["excluded-codex", "excluded-grok", "excluded-openrouter", "excluded-unknown"]) {
		expect(resolve(id)).toEqual(unavailable);
	}
});

const invalidCosts: ModelCost[] = [
	...[Number.NaN, Number.POSITIVE_INFINITY, -1].flatMap(value =>
		(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => ({ ...rates, [key]: value }))),
	...[Number.NaN, Number.POSITIVE_INFINITY, -1].flatMap(value =>
		(["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const)
			.map(key => ({ ...rates, tiers: [{ ...rates.tiers![0], [key]: value }] }))),
];
it.each(invalidCosts)("ignores invalid base or tier prices %j", cost => {
	for (const providers of [[catalog("openai", "fixture", cost)],
		[catalog("openai", "fixture", cost), catalog("deepseek", "fixture")],
		[catalog("deepseek", "fixture"), catalog("openai", "fixture", cost)]]) {
		const resolve = createMagpiePricingResolver(providers);
		expect(resolve("any/fixture")).toEqual(providers.length === 1 ? unavailable : { ...rates, magpiePricing: "estimate" });
	}
});

it("distinguishes explicitly free catalog entries from missing prices", () => {
	const resolve = createMagpiePricingResolver([
		catalog("openai", "free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	]);
	expect(resolve("any/free")).toEqual({ ...unavailable, magpiePricing: "estimate" });
	expect(resolve("any/missing")).toEqual(unavailable);
});

it("keeps equal duplicate prices available by value regardless of property or provider order", () => {
	const reordered: ModelCost = { tiers: [{ cacheWrite: 5, cacheRead: 0.4, output: 20, input: 4, inputTokensAbove: 200000 }],
		cacheWrite: 2.5, output: 10, input: 2, cacheRead: 0.2 };
	const providers = [catalog("openai", "canonical/fixture"), catalog("anthropic", "nested/fixture", reordered)];
	for (const order of [providers, [...providers].reverse()]) {
		const resolve = createMagpiePricingResolver(order);
		for (const id of ["fixture", "openai/fixture", "anthropic/fixture", "unknown/nested/fixture"]) {
			expect(resolve(id)).toEqual({ ...rates, magpiePricing: "estimate" });
		}
	}
	const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	expect(createMagpiePricingResolver([catalog("openai", "free", free), catalog("xai", "free", { ...free, tiers: [] })])("free"))
		.toEqual({ ...free, magpiePricing: "estimate" });
});

const conflictingCosts: ModelCost[] = [
	...(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => ({ ...rates, [key]: rates[key] + 1 })),
	...(["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const)
		.map(key => ({ ...rates, tiers: [{ ...rates.tiers![0], [key]: rates.tiers![0][key] + 1 }] })),
	{ ...rates, tiers: [] },
	{ ...rates, tiers: [...rates.tiers!, { ...rates.tiers![0], inputTokensAbove: 500000 }] },
];
it.each(conflictingCosts)("keeps conflicting canonical prices unavailable regardless of source order or gateway prefix: %j", cost => {
	const first = catalog("openai", "fixture");
	const conflict = catalog("anthropic", "canonical/fixture", cost);
	const repeat = catalog("xai", "fixture");
	for (const order of [[first, conflict, repeat], [conflict, first, repeat], [repeat, first, conflict]]) {
		const resolve = createMagpiePricingResolver(order);
		for (const id of ["fixture", "openai/fixture", "anthropic/fixture", "xai/fixture", "unknown/nested/fixture"]) {
			expect(resolve(id)).toEqual(unavailable);
		}
	}
});

it("installs upstream prices without changing Magpie routing or advertised model metadata", () => {
	const [model] = parseModels({ data: [{ id: "codex/gpt-4.1", context_window: 12345, native_endpoints: ["/v1/responses"] }] }, "https://gateway.example");
	expect(model).toMatchObject({ id: "codex/gpt-4.1", provider: "magpie", baseUrl: "https://gateway.example/v1",
		api: "openai-responses", contextWindow: 12345, magpiePricing: "estimate" });
	expect(model.cost.input).toBeGreaterThan(0);
	expect(model.cost.output).toBeGreaterThan(0);
	const usage = emptyUsage();
	usage.input = 1000;
	usage.output = 100;
	expect(calculateCost(model, usage).total).toBeGreaterThan(0);
});

it("prices bare and qualified gpt-5.4 identically with realistic context tiers", () => {
	const metadata = { native_endpoints: ["/v1/responses"], display_name: "Advertised model",
		context_window: 400000, max_output_tokens: 12345, modalities: { input: ["text", "image"] }, reasoning_levels: ["none", "high"] };
	const [bare, qualified] = parseModels({ data: [
		{ ...metadata, id: "gpt-5.4" }, { ...metadata, id: "unfamiliar/nested/gpt-5.4", owned_by: "contradictory-owner" },
	] }, "https://gateway.example");
	expect(bare.cost).toEqual(qualified.cost);
	expect(bare.cost).toMatchObject({ magpiePricing: "estimate", tiers: [expect.objectContaining({ inputTokensAbove: expect.any(Number) })] });
	expect(bare.cost.input).toBeGreaterThan(0);
	const { magpieRoute: _bareRoute, ...publicBare } = bare;
	const { magpieRoute: _qualifiedRoute, ...publicQualified } = qualified;
	expect(publicBare).toEqual({ ...publicQualified, id: "gpt-5.4" });
	const threshold = bare.cost.tiers![0].inputTokensAbove;
	for (const input of [1000, threshold + 1]) {
		const usage = { ...emptyUsage(), input, output: 100, cacheRead: 50, cacheWrite: 25 };
		expect(calculateCost(bare, structuredClone(usage))).toEqual(calculateCost(qualified, structuredClone(usage)));
	}
	const tierUsage = { ...emptyUsage(), input: threshold + 1 };
	expect(calculateCost(bare, tierUsage).input).toBeCloseTo(tierUsage.input * bare.cost.tiers![0].input / 1000000);
});

it.each([
	{},
	{ owned_by: "openai", native_endpoints: ["/v1/responses"] },
	{ owned_by: "anthropic", native_endpoints: ["/v1/messages"] },
	{ owned_by: "unknown-vendor", native_endpoints: [] },
	{ owned_by: null, native_endpoints: ["/v1/unknown"] },
	{ owned_by: "malformed owner/*", magpieQualifiedId: "anthropic/nonexistent", cost: { input: 999 }, magpiePricing: "unavailable" },
])("uses only the model name despite owner or other discovery metadata: %j", metadata => {
	const expected = createMagpiePricingResolver()("gpt-5.4");
	for (const id of ["gpt-5.4", "group/gpt-5.4", "anthropic/gpt-5.4", "unknown/nested/gpt-5.4"]) {
		const [model] = parseModels({ data: [{ ...metadata, id }] }, "https://gateway.example");
		expect(model.id).toBe(id);
		expect(model.cost).toEqual(expected);
		expect(model.cost).toMatchObject({ magpiePricing: "estimate" });
		expect(model).not.toHaveProperty("magpieQualifiedId");
	}
});

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

it.each(["estimate", "unavailable"] as const)("preserves %s provenance in streaming, summary results, serialized history, and native compaction", async pricing => {
	const [base] = parseModels({ data: [{ id: "fixture", native_endpoints: ["/v1/responses"] }] }, "https://gateway.example");
	const model = { ...base, cost: { ...(pricing === "estimate" ? rates : base.cost), magpiePricing: pricing } };
	const usage = { ...emptyUsage(), input: 300000, output: 100, totalTokens: 300100 };
	calculateCost(model, usage);
	const message: AssistantMessage = { role: "assistant", provider: "magpie", model: model.id, api: "openai-responses",
		content: [], stopReason: "stop", timestamp: 0, usage };
	const source = createAssistantMessageEventStream();
	source.push({ type: "start", partial: message });
	source.push({ type: "done", reason: "stop", message });
	const recordPricing = vi.fn();
	const stream = withMagpiePricing(source, model, recordPricing);
	// Summary generators consume result() without iterating or firing message_end.
	const result = await stream.result();
	expect(recordPricing).toHaveBeenCalledExactlyOnceWith(pricing);
	const events = [];
	for await (const event of stream) events.push(event);
	expect(events[0]).toMatchObject({ type: "start", partial: { usage: { cost: { magpiePricing: pricing } } } });
	expect(events[1]).toMatchObject({ type: "done", message: { usage: { cost: { magpiePricing: pricing } } } });
	expect(JSON.parse(JSON.stringify(result)).usage.cost.magpiePricing).toBe(pricing);
	expect(result.usage.cost.total).toBe(usage.cost.total);
	expect(message.usage.cost).not.toHaveProperty("magpiePricing");
	const nativeUsage = usageFromResponse(model, { input_tokens: 300000, output_tokens: 100 });
	expect(nativeUsage?.cost).toMatchObject({ magpiePricing: pricing });
	expect(nativeUsage?.cost.total).toBeCloseTo(usage.cost.total);
});

it.each(["done", "error", "aborted"] as const)("preserves a delegated %s response after the pricing recorder's extension is invalidated", async terminal => {
	const [model] = parseModels({ data: [{ id: "unpriced" }] }, "https://gateway.example");
	const runtime = createExtensionRuntime();
	runtime.appendEntry = vi.fn();
	const recordPricing = vi.fn(() => {
		runtime.assertActive();
		runtime.appendEntry("magpie-pricing", { pricing: "unavailable" });
	});
	// Shared model runtimes can retain a provider registered by a disposed child.
	runtime.invalidate();
	const message: AssistantMessage = { role: "assistant", provider: "magpie", model: model.id, api: model.api,
		content: [{ type: "text", text: "The release monitor completed." }], timestamp: 0,
		stopReason: terminal === "done" ? "stop" : terminal,
		...(terminal === "done" ? {} : { errorMessage: "original delegated failure" }),
		usage: { ...emptyUsage(), input: 10, output: 2, totalTokens: 12 } };
	const source = createAssistantMessageEventStream();
	source.push({ type: "start", partial: message });
	if (terminal === "done") source.push({ type: "done", reason: "stop", message });
	else source.push({ type: "error", reason: terminal, error: message });
	const stream = withMagpiePricing(source, model, recordPricing);
	const result = await stream.result();
	expect(recordPricing).toHaveBeenCalledExactlyOnceWith("unavailable");
	expect(runtime.appendEntry).not.toHaveBeenCalled();
	expect(result).toMatchObject({ ...message, usage: { ...message.usage, cost: { ...message.usage.cost, magpiePricing: "unavailable" } } });
	const events = [];
	for await (const event of stream) events.push(event);
	expect(events.map(event => event.type)).toEqual(["start", terminal === "done" ? "done" : "error"]);
});

it("preserves error and cancellation messages with unavailable pricing", async () => {
	const [model] = parseModels({ data: [{ id: "unpriced" }] }, "https://gateway.example");
	const error: AssistantMessage = { role: "assistant", provider: "magpie", model: model.id, api: "openai-completions",
		content: [], stopReason: "aborted", errorMessage: "cancelled", timestamp: 0, usage: emptyUsage() };
	const source = createAssistantMessageEventStream();
	source.push({ type: "error", reason: "aborted", error });
	const result = await withMagpiePricing(source, model).result();
	expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "cancelled", usage: { cost: { magpiePricing: "unavailable" } } });
});
