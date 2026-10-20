import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type ModelCost, type Provider, type Usage } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type MagpiePricing = "estimate" | "unavailable";
export type MagpieCost = ModelCost & { magpiePricing: MagpiePricing };

const upstreamProviders: Readonly<Record<string, string>> = {
	auto: "anthropic", mercerrouter: "anthropic", anthropic: "anthropic",
	codex: "openai", openai: "openai", deepseek: "deepseek", grok: "xai", xai: "xai",
};

function validRates(cost: ModelCost): boolean {
	return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(rate => Number.isFinite(rate) && rate >= 0)
		&& (cost.tiers ?? []).every(tier => Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= 0
			&& [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(rate => Number.isFinite(rate) && rate >= 0));
}

/** Exact upstream model IDs only: aliases, context suffixes, and routing groups stay unpriced. */
export function createMagpiePricingResolver(providers: readonly Pick<Provider, "id" | "getModels">[] = builtinProviders()) {
	const prices = new Map<string, ModelCost>();
	const supported = new Set(Object.values(upstreamProviders));
	for (const provider of providers) {
		if (!supported.has(provider.id)) continue;
		for (const model of provider.getModels()) {
			if (validRates(model.cost)) prices.set(`${provider.id}/${model.id}`, model.cost);
		}
	}
	return (id: string): MagpieCost => {
		const slash = id.indexOf("/");
		const upstream = upstreamProviders[id.slice(0, slash)];
		const cost = slash > 0 && upstream ? prices.get(`${upstream}/${id.slice(slash + 1)}`) : undefined;
		return cost
			? { ...structuredClone(cost), magpiePricing: "estimate" }
			: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, magpiePricing: "unavailable" };
	};
}

/** Keep pricing provenance with recorded usage; zero rates alone cannot mean free. */
export function markMagpieUsage(usage: Usage, pricing: MagpiePricing): Usage {
	return { ...usage, cost: { ...usage.cost, magpiePricing: pricing } } as Usage;
}

/** Attach provenance at the stream boundary, including calls made by Pi's summary generators. */
export function withMagpiePricing(source: AssistantMessageEventStream, model: Model<any>, recordPricing?: (pricing: MagpiePricing) => void): AssistantMessageEventStream {
	const recorded = (model.cost as Partial<MagpieCost>).magpiePricing;
	const pricing = recorded ?? ([model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite]
		.some(rate => rate > 0) ? "estimate" : "unavailable");
	const mark = (message: AssistantMessage): AssistantMessage => ({ ...message, usage: markMagpieUsage(message.usage, pricing) });
	const record = (message: AssistantMessage) => {
		const usage = message.usage;
		if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) recordPricing?.(pricing);
	};
	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") {
					record(event.message);
					stream.push({ ...event, message: mark(event.message) });
				} else if (event.type === "error") {
					record(event.error);
					stream.push({ ...event, error: mark(event.error) });
				}
				else stream.push(event.partial ? { ...event, partial: mark(event.partial) } : event);
			}
		} catch {
			stream.push({ type: "error", reason: "error", error: {
				role: "assistant", provider: "magpie", model: model.id, api: model.api, content: [],
				stopReason: "error", errorMessage: "Magpie response stream failed.", timestamp: Date.now(),
				usage: markMagpieUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, pricing),
			} });
		} finally {
			stream.end();
		}
	})();
	return stream;
}
