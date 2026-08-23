import { record } from "./usage-accounting.ts";

export interface AssistantResult {
	text?: string;
	error?: string;
	failed: boolean;
}

export function assistantText(value: unknown): string | undefined {
	const message = record(value);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.map(record)
		.filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
		.map((item) => String(item.text))
		.join("\n");
	return text.trim() ? text : undefined;
}

export function responseActivity(text: string | undefined): string | undefined {
	const line = text?.split("\n").find((candidate) => candidate.trim())?.trim();
	if (!line) return undefined;
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Decode the final assistant message, without choosing a layer-specific fallback. */
export function decodeAssistantResult(messages: readonly unknown[]): AssistantResult | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = record(messages[index]);
		if (candidate?.role !== "assistant") continue;
		const text = assistantText(candidate);
		const stopReason = String(candidate.stopReason || "");
		const error = typeof candidate.errorMessage === "string" && candidate.errorMessage.trim()
			? candidate.errorMessage.trim()
			: undefined;
		return {
			...(text === undefined ? {} : { text }),
			...(error ? { error } : {}),
			failed: stopReason === "error" || stopReason === "aborted" || Boolean(error),
		};
	}
	return undefined;
}

export function finalAssistantResult(messages: readonly unknown[]): AssistantResult {
	return decodeAssistantResult(messages) ?? { failed: true, error: "Pi worker returned no assistant result." };
}
