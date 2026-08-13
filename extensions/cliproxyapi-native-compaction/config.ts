import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "cliproxyapi-native-compaction.json";
export const DEFAULT_NATIVE_MODELS = ["gpt-5.6-sol"] as const;

export interface NativeCompactionConfig {
	enabled: boolean;
	providerId: string;
	apiId: string;
	models: string[];
	endpoint?: string;
	/** When native compact fails and the session has no native checkpoint, let Pi's built-in summarizer run. */
	fallbackToBuiltin: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(path: string): JsonObject | undefined {
	if (!existsSync(path)) return undefined;
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isObject(value)) throw new Error(`${path} must contain a JSON object.`);
	return value;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) {
		throw new Error(`${field} must be an array of non-empty model IDs.`);
	}
	return [...new Set(value.map((entry) => String(entry).trim()))];
}

function parseBoolean(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function applyConfig(base: NativeCompactionConfig, value: JsonObject | undefined): NativeCompactionConfig {
	if (!value) return base;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : base.enabled,
		providerId: nonEmptyString(value.providerId) ?? base.providerId,
		apiId: nonEmptyString(value.apiId) ?? base.apiId,
		models: stringArray(value.models, "models") ?? base.models,
		endpoint: nonEmptyString(value.endpoint) ?? base.endpoint,
		fallbackToBuiltin:
			typeof value.fallbackToBuiltin === "boolean" ? value.fallbackToBuiltin : base.fallbackToBuiltin,
	};
}

function configuredProviderId(agentDir: string): string | undefined {
	try {
		return nonEmptyString(readObject(join(agentDir, "cliproxyapi.json"))?.providerId);
	} catch {
		return undefined;
	}
}

export function loadConfig(cwd: string, projectTrusted: boolean): NativeCompactionConfig {
	const agentDir = getAgentDir();
	let config: NativeCompactionConfig = {
		enabled: true,
		providerId: configuredProviderId(agentDir) ?? "cliproxyapi",
		apiId: "cliproxyapi-codex-responses",
		models: [...DEFAULT_NATIVE_MODELS],
		fallbackToBuiltin: true,
	};

	config = applyConfig(config, readObject(join(agentDir, CONFIG_FILE_NAME)));
	if (projectTrusted) {
		config = applyConfig(config, readObject(join(cwd, ".pi", CONFIG_FILE_NAME)));
	}

	const envModels = process.env.PI_CLIPROXYAPI_NATIVE_COMPACTION_MODELS;
	if (envModels !== undefined) {
		config.models = [...new Set(envModels.split(",").map((value) => value.trim()).filter(Boolean))];
	}
	const envEndpoint = nonEmptyString(process.env.PI_CLIPROXYAPI_NATIVE_COMPACTION_ENDPOINT);
	if (envEndpoint) config.endpoint = envEndpoint;
	const envFallback = process.env.PI_CLIPROXYAPI_NATIVE_COMPACTION_FALLBACK;
	if (envFallback !== undefined) {
		const parsed = parseBoolean(envFallback);
		if (parsed !== undefined) config.fallbackToBuiltin = parsed;
	}

	return config;
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
