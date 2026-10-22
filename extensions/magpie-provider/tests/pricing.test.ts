import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type Model, type ModelCost, type Provider, type Usage } from "@earendil-works/pi-ai";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { parseModels } from "../index.ts";
import { createMagpiePricingResolver, withMagpiePricing } from "../pricing.ts";
import { usageFromResponse } from "../native-compaction/native-compaction.ts";

const rates: ModelCost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
	tiers: [{ inputTokensAbove: 200000, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }] };
function catalog(provider: string, id: string, cost = rates): Pick<Provider, "id" | "getModels"> {
	return { id: provider, getModels: () => [{ id, provider, cost } as Model<any>] };
}

it("maps only known namespaces to exact upstream IDs and preserves independent cache and tier prices", () => {
	const resolve = createMagpiePricingResolver([
		catalog("openai", "gpt-fixture"), catalog("anthropic", "claude-fixture"),
		catalog("deepseek", "deepseek-fixture"), catalog("xai", "grok-fixture"),
	]);
	for (const id of ["openai/gpt-fixture", "codex/gpt-fixture", "auto/claude-fixture", "mercerrouter/claude-fixture",
		"anthropic/claude-fixture", "deepseek/deepseek-fixture", "grok/grok-fixture", "xai/grok-fixture"]) {
		const cost = resolve(id);
		expect(cost).toEqual({ ...rates, magpiePricing: "estimate" });
		cost.tiers![0].input = 999;
		expect(resolve(id).tiers![0].input).toBe(4);
	}
});

it.each(["group/gpt-fixture", "vendor/gpt-fixture", "gpt-fixture", "codex/gpt-fixture-new",
	"grok/grok-fixture@500k", "grok/grok-fixture-build-fast", "openai/claude-fixture"])("leaves ambiguous or unmatched %s unpriced", id => {
	const resolve = createMagpiePricingResolver([catalog("openai", "gpt-fixture"), catalog("xai", "grok-fixture"), catalog("anthropic", "claude-fixture")]);
	expect(resolve(id)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, magpiePricing: "unavailable" });
});

it("distinguishes explicitly free catalog entries from missing or invalid prices", () => {
	const resolve = createMagpiePricingResolver([
		catalog("openai", "free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		catalog("deepseek", "invalid", { ...rates, input: Number.NaN }),
	]);
	expect(resolve("openai/free").magpiePricing).toBe("estimate");
	expect(resolve("deepseek/invalid").magpiePricing).toBe("unavailable");
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
