import type { Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type MagpieApi = "openai-completions" | "openai-responses" | "anthropic-messages";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultToolStrict(tools: unknown): { tools: unknown; changed: boolean } {
	if (!Array.isArray(tools)) return { tools, changed: false };
	let changed = false;
	const next = tools.map(tool => {
		if (!isRecord(tool)) return tool;
		if (tool.type === "function" && tool.strict === undefined) {
			changed = true;
			return { ...tool, strict: false };
		}
		if (tool.type === "namespace") {
			const nested = defaultToolStrict(tool.tools);
			if (nested.changed) {
				changed = true;
				return { ...tool, tools: nested.tools };
			}
		}
		return tool;
	});
	return changed ? { tools: next, changed: true } : { tools, changed: false };
}

/**
 * Pi omits `strict` on Responses function tools when strict schema rewriting is off, while ChatGPT/Codex
 * Responses backends hold tools without `strict` to strict-mode constrained decoding. Explicit `strict: false`
 * keeps optional arguments optional without rewriting schemas; Magpie strips `strict` if a vendor rejects it.
 */
export function withResponsesToolStrict(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const top = defaultToolStrict(payload.tools);
	let input = payload.input;
	let inputChanged = false;
	if (Array.isArray(input)) {
		const mapped = input.map(item => {
			if (!isRecord(item) || item.type !== "additional_tools") return item;
			const nested = defaultToolStrict(item.tools);
			if (!nested.changed) return item;
			inputChanged = true;
			return { ...item, tools: nested.tools };
		});
		if (inputChanged) input = mapped;
	}
	if (!top.changed && !inputChanged) return payload;
	return {
		...payload,
		...(top.changed ? { tools: top.tools } : {}),
		...(inputChanged ? { input } : {}),
	};
}

function wrapResponsesOptions<T extends StreamOptions | undefined>(options: T): NonNullable<T> {
	const onPayload = options?.onPayload;
	return {
		...options,
		onPayload: async (payload: unknown, model: Model<any>) => {
			const normalized = withResponsesToolStrict(payload);
			const next = await onPayload?.(normalized, model);
			return next === undefined ? normalized : next;
		},
	} as NonNullable<T>;
}

export function createMagpieStreams(): Record<MagpieApi, Pick<Provider, "stream" | "streamSimple">> {
	// Pi's bundled extension loader exposes providers/all, but not api/*.
	// These providers dispatch directly to the native API implementations without
	// applying their authentication or endpoint defaults to the supplied model.
	const providers = builtinProviders();
	const provider = (id: string) => {
		const result = providers.find(provider => provider.id === id);
		if (!result) throw new Error(`Magpie requires Pi's built-in ${id} provider.`);
		return result;
	};
	const responses = provider("openai");
	return {
		"openai-completions": provider("groq"),
		"openai-responses": {
			stream: (model, context, options) => responses.stream(model, context, wrapResponsesOptions(options)),
			streamSimple: (model, context, options) => responses.streamSimple(model, context, wrapResponsesOptions(options)),
		},
		"anthropic-messages": provider("anthropic"),
	};
}
