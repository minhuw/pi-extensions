import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type ModelCost, type Provider, type Usage } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { magpieModelName } from "./model-identity.ts";
import { markMagpieAliasMessage } from "./model-aliases.ts";

export type MagpiePricing = "estimate" | "unavailable";
export type MagpieCost = ModelCost & { magpiePricing: MagpiePricing };

const upstreamProviders = new Set(["anthropic", "openai", "deepseek", "xai"]);

function validRates(cost: ModelCost): boolean {
	return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(rate => Number.isFinite(rate) && rate >= 0)
		&& (cost.tiers ?? []).every(tier => Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= 0
			&& [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(rate => Number.isFinite(rate) && rate >= 0));
}

function equalRates(left: ModelCost, right: ModelCost): boolean {
	return left.input === right.input && left.output === right.output
		&& left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite;
}

function equalCosts(left: ModelCost, right: ModelCost): boolean {
	const leftTiers = left.tiers ?? [];
	const rightTiers = right.tiers ?? [];
	return equalRates(left, right) && leftTiers.length === rightTiers.length
		&& leftTiers.every((tier, index) => tier.inputTokensAbove === rightTiers[index].inputTokensAbove
			&& equalRates(tier, rightTiers[index]));
}

/** Exact model names across canonical catalogs; conflicting valid prices stay unavailable. */
export function createMagpiePricingResolver(providers: readonly Pick<Provider, "id" | "getModels">[] = builtinProviders()) {
	const prices = new Map<string, ModelCost>();
	const ambiguous = new Set<string>();
	for (const provider of providers) {
		if (!upstreamProviders.has(provider.id)) continue;
		for (const model of provider.getModels()) {
			const name = magpieModelName(model.id);
			if (!name || !validRates(model.cost) || ambiguous.has(name)) continue;
			const previous = prices.get(name);
			if (previous && !equalCosts(previous, model.cost)) {
				prices.delete(name);
				ambiguous.add(name);
			} else if (!previous) prices.set(name, model.cost);
		}
	}
	return (id: string): MagpieCost => {
		const name = magpieModelName(id);
		const cost = name ? prices.get(name) : undefined;
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
	const mark = (message: AssistantMessage): AssistantMessage => ({ ...markMagpieAliasMessage(message, model), usage: markMagpieUsage(message.usage, pricing) });
	const record = (message: AssistantMessage) => {
		const usage = message.usage;
		if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) {
			try {
				recordPricing?.(pricing);
			} catch {
				// A shared model runtime can outlive the extension session that
				// registered this recorder. Optional provenance must not replace a
				// delegated response, its usage, or its original error/cancellation.
			}
		}
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
			stream.push({ type: "error", reason: "error", error: mark({
				role: "assistant", provider: "magpie", model: model.id, api: model.api, content: [],
				stopReason: "error", errorMessage: "Magpie response stream failed.", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}) });
		} finally {
			stream.end();
		}
	})();
	return stream;
}
