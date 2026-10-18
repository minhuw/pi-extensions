import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type MagpieApi = "openai-completions" | "openai-responses" | "anthropic-messages";

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
	return {
		"openai-completions": provider("groq"),
		"openai-responses": provider("openai"),
		"anthropic-messages": provider("anthropic"),
	};
}
