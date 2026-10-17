export interface NativeCompactionConfig {
	enabled: boolean;
	providerId: string;
	apiId: string;
	models: string[];
	endpoint?: string;
	/** When native compact fails and the session has no native checkpoint, let Pi's built-in summarizer run. */
	fallbackToBuiltin: boolean;
}

export function isEligibleModel(
	model: { provider?: unknown; api?: unknown; id?: unknown } | undefined,
	config: NativeCompactionConfig,
): boolean {
	return Boolean(
		config.enabled &&
		model &&
		model.provider === config.providerId &&
		model.api === config.apiId &&
		typeof model.id === "string" &&
		config.models.includes(model.id),
	);
}
