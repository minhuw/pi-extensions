import type { SessionStats } from "@earendil-works/pi-coding-agent";

export function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function messageUsageTokens(usage: unknown): number {
	const value = record(usage);
	if (!value) return 0;
	return (finiteCount(value.input) ?? 0) + (finiteCount(value.output) ?? 0) + (finiteCount(value.cacheWrite) ?? 0);
}

export function sessionUsageTotals(session: {
	readonly messages: readonly unknown[];
	getSessionStats(): SessionStats;
}): {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens?: number;
} {
	const stats = session.getSessionStats();
	let reasoningTokens = 0;
	let reasoningKnown = false;
	for (const value of session.messages) {
		const assistant = record(value);
		if (assistant?.role !== "assistant") continue;
		const reasoning = finiteCount(record(assistant.usage)?.reasoning);
		if (reasoning === undefined) continue;
		reasoningKnown = true;
		reasoningTokens += reasoning;
	}
	return {
		inputTokens: stats.tokens.input,
		cachedInputTokens: stats.tokens.cacheRead,
		outputTokens: stats.tokens.output,
		...(reasoningKnown ? { reasoningTokens } : {}),
	};
}
