import {
	type Model,
	type ApiKeyCredential,
	type Provider,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMagpieCompaction } from "./compaction.ts";
import { addMagpieModelAliases, assertMagpieAliasRoute, magpieRequestContext, resolveMagpieAlias, type MagpieModel } from "./model-aliases.ts";
import { assertNativeCatalog } from "./models-config.ts";
import { selectMagpiePickerModels } from "./model-picker.ts";
import { hasConfiguredModelScope } from "./picker-scope.ts";
import { MAGPIE_SEARCH_SERVER, magpieSearchConfig, type MagpieSearchConnection } from "./mcp.ts";
import { createMagpieStreams, type MagpieApi } from "./streams.ts";
import { createMagpiePricingResolver, withMagpiePricing, type MagpiePricing } from "./pricing.ts";

export const DISCOVERY_TIMEOUT_MS = 3000;
interface Config { origin: string; apiKey?: string }

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
	let url: URL;
	try { url = new URL(env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425"); }
	catch { throw new Error("MAGPIE_BASE_URL must be an HTTP(S) gateway origin."); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
		url.href.includes('?') || url.href.includes('#') || !/^\/(?:v1\/?)?$/.test(url.pathname)) {
		throw new Error("MAGPIE_BASE_URL must be an HTTP(S) origin, optionally ending in /v1, without credentials, query, or fragment.");
	}
	const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
	const apiKey = env.MAGPIE_API_KEY?.trim() || (loopback ? "magpie-pi" : undefined);
	return { origin: url.origin, apiKey };
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function limit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function parseModels(value: unknown, origin: string): MagpieModel[] {
	if (!object(value) || !Array.isArray(value.data)) throw new Error("Magpie returned an invalid model catalog.");
	const models: Model<MagpieApi>[] = [];
	const resolvePricing = createMagpiePricingResolver();
	const seen = new Set<string>();
	for (const entry of value.data) {
		if (!object(entry) || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id)) continue;
		const modalities = object(entry.modalities) ? entry.modalities : {};
		const output = strings(modalities.output);
		if (output.length && !output.includes("text") && output.some(v => v === "image" || v === "audio")) continue;
		const endpoints = strings(entry.native_endpoints);
		const api = endpoints.includes("/v1/responses") ? "openai-responses" :
			endpoints.includes("/v1/messages") ? "anthropic-messages" : "openai-completions";
		const efforts = Array.isArray(entry.supported_reasoning_levels)
			? entry.supported_reasoning_levels.flatMap(v => object(v) && typeof v.effort === "string" ? [v.effort] : []) : [];
		if (!efforts.length) efforts.push(...strings(entry.reasoning_levels));
		// Match Magpie's gateway/anthropic.go Claude version recognition, not all Messages models.
		const version = entry.id.toLowerCase().match(/(?:^|[^a-z0-9])(?:claude-)?(?:opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2}))?(?:[^0-9]|$)|claude-(\d+)(?:[-.](\d))?-(?:opus|sonnet|haiku)/);
		const claude = /(?:^|[/.:-])claude-/i.test(entry.id) || version !== null;
		const major = Number(version?.[3] ?? version?.[1]);
		const minor = Number(version?.[4] ?? version?.[2] ?? 0);
		const adaptive = api === "anthropic-messages" && version !== null && (major > 4 || major === 4 && minor >= 6);
		let thinkingLevelMap: ThinkingLevelMap | undefined;
		if (efforts.length) {
			thinkingLevelMap = {};
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
				const effort = level === "off" ? "none" : level;
				thinkingLevelMap[level] = efforts.includes(effort) ? effort : null;
			}
			if (api === "anthropic-messages" && claude && thinkingLevelMap.off === null) delete thinkingLevelMap.off;
		}
		const contextWindow = limit(entry.context_window, 32768);
		const cost = resolvePricing(entry.id);
		models.push({
			magpiePricing: cost.magpiePricing,
			id: entry.id, name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : entry.id,
			provider: "magpie", api, baseUrl: api === "anthropic-messages" ? origin : `${origin}/v1`,
			reasoning: entry.reasoning === true || efforts.length > 0,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(api !== "openai-responses" ? { compat: {
				sendSessionAffinityHeaders: true,
				...(adaptive ? { forceAdaptiveThinking: true } : {}),
			} } : {}),
			input: strings(modalities.input).includes("image") ? ["text", "image"] : ["text"],
			contextWindow, maxTokens: Math.min(contextWindow, limit(entry.max_output_tokens, 4096)),
			cost,
		} as Model<MagpieApi>);
		seen.add(entry.id);
	}
	if (!models.length) throw new Error("Magpie returned no usable chat models; keeping the previous catalog.");
	return addMagpieModelAliases(models, value.data);
}

export async function discoverModels(config: Config, signal?: AbortSignal, allowEmpty = false): Promise<Model<MagpieApi>[]> {
	assertNativeCatalog();
	if (!config.apiKey) throw new Error("MAGPIE_API_KEY is required for a non-loopback gateway.");
	const bounded = AbortSignal.any([AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	let response: Response;
	let body: unknown;
	try {
		bounded.throwIfAborted();
		response = await fetch(`${config.origin}/v1/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` }, signal: bounded, redirect: "error",
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		body = await response.json();
		bounded.throwIfAborted();
	} catch {
		// Never expose fetch errors or response bodies: either can contain credentials.
		if (bounded.aborted) throw new Error(signal?.aborted ? "Magpie discovery cancelled." : "Magpie discovery timed out.");
		throw new Error("Magpie model discovery failed; check gateway availability, credentials, and /v1/models response.");
	}
	if (allowEmpty && object(body) && Array.isArray(body.data) && body.data.length === 0) return [];
	return parseModels(body, config.origin);
}

export function createMagpieProvider(
	env: NodeJS.ProcessEnv = process.env,
	publishConnection?: (connection: MagpieSearchConnection | undefined) => void,
	recordPricing?: (pricing: MagpiePricing) => void,
	preserveScope: () => boolean = () => false,
): Provider<MagpieApi> {
	// Keep raw ambient values separate from saved credentials and loopback defaults.
	const ambient = { MAGPIE_BASE_URL: env.MAGPIE_BASE_URL, MAGPIE_API_KEY: env.MAGPIE_API_KEY };
	const connection = (credential?: ApiKeyCredential) => readConfig({
		MAGPIE_BASE_URL: credential?.env?.MAGPIE_BASE_URL ?? ambient.MAGPIE_BASE_URL,
		MAGPIE_API_KEY: credential?.key ?? ambient.MAGPIE_API_KEY,
	});
	let current = connection();
	let storedIdentity: string | undefined;
	let models: Model<MagpieApi>[] = [];
	const requestModel = (selected: Model<MagpieApi>) => {
		const model = resolveMagpieAlias(selected);
		return model.api === "anthropic-messages"
			? { ...model, baseUrl: model.baseUrl.replace(/\/v1\/?$/, "") } : model;
	};
	const apis = createMagpieStreams();
	return {
		id: "magpie", name: "Magpie",
		auth: { apiKey: {
			name: "Magpie API key",
			async login(interaction) {
				assertNativeCatalog();
				const { signal } = interaction;
				const check = () => { if (signal.aborted) throw new Error("Magpie login cancelled."); };
				check();
				const url = await interaction.prompt({ type: "text", message: `Gateway URL (blank uses ${current.origin})`, placeholder: current.origin, signal });
				check();
				const origin = readConfig({ MAGPIE_BASE_URL: url.trim() || current.origin }).origin;
				const key = await interaction.prompt({ type: "secret", message: "Gateway API key (blank uses magpie-pi on loopback only)", signal });
				check();
				const config = readConfig({ MAGPIE_BASE_URL: origin, MAGPIE_API_KEY: key });
				interaction.notify({ type: "progress", message: "Validating Magpie connection…" });
				await discoverModels(config, signal, true);
				check();
				return { type: "api_key", key: config.apiKey, env: { MAGPIE_BASE_URL: origin } };
			},
			async resolve({ credential, ctx, signal }) {
				assertNativeCatalog();
				signal.throwIfAborted();
				const config = readConfig({
					MAGPIE_BASE_URL: credential?.env?.MAGPIE_BASE_URL ?? ambient.MAGPIE_BASE_URL ?? await ctx.env("MAGPIE_BASE_URL"),
					MAGPIE_API_KEY: credential?.key ?? ambient.MAGPIE_API_KEY ?? await ctx.env("MAGPIE_API_KEY"),
				});
				signal.throwIfAborted();
				if (!config.apiKey) return undefined;
				return { auth: { apiKey: config.apiKey, baseUrl: `${config.origin}/v1` },
					env: { MAGPIE_BASE_URL: config.origin }, source: "Magpie API key" };
			},
		} },
		getModels: () => models,
		filterModels: models => selectMagpiePickerModels(models, preserveScope()),
		filterAllModels: models => selectMagpiePickerModels(models, preserveScope()),
		async refreshModels(context) {
			assertNativeCatalog();
			const config = connection(context.credential?.type === "api_key" ? context.credential : undefined);
			context.signal.throwIfAborted();
			if (!context.allowNetwork) {
				const credential = context.credential?.type === "api_key" ? context.credential : undefined;
				const identity = credential ? JSON.stringify([credential.key, credential.env?.MAGPIE_BASE_URL]) : undefined;
				// Native Models runs this raw-credential phase before resolved network auth.
				// Only this phase can establish/remove stored provenance: ambient auth must
				// never enable MCP, and must not clear a retained effective-key catalog.
				if (identity !== storedIdentity) {
					await context.publish({ update: () => {
						storedIdentity = identity;
						current = config;
						models = [];
						publishConnection?.(credential && config.apiKey ? { origin: config.origin, apiKey: config.apiKey } : undefined);
					} });
				}
				return;
			}
			if (config.origin !== current.origin || config.apiKey !== current.apiKey) {
				const accepted = await context.publish({ update: () => {
					current = config;
					models = [];
					if (storedIdentity !== undefined) publishConnection?.(config.apiKey ? { origin: config.origin, apiKey: config.apiKey } : undefined);
				} });
				if (!accepted) return;
			}
			if (!config.apiKey) return;
			const next = await discoverModels(config, context.signal);
			context.signal.throwIfAborted();
			await context.publish({ update: () => { current = config; models = next; } });
		},
		stream: (model, context, options) => {
			assertMagpieAliasRoute(model, models, context.messages);
			return withMagpiePricing(apis[model.api].stream(requestModel(model), magpieRequestContext(context), options), model, recordPricing);
		},
		streamSimple: (model, context, options) => {
			assertMagpieAliasRoute(model, models, context.messages);
			return withMagpiePricing(apis[model.api].streamSimple(requestModel(model), magpieRequestContext(context), options), model, recordPricing);
		},
	};
}

export default async function magpie(pi: ExtensionAPI): Promise<void> {
	assertNativeCatalog();
	const preserveScope = () => hasConfiguredModelScope(() => pi.getSettings());
	const provider = createMagpieProvider(process.env, connection => {
		if (connection) pi.registerMcpServer(MAGPIE_SEARCH_SERVER, magpieSearchConfig(connection));
		else pi.unregisterMcpServer(MAGPIE_SEARCH_SERVER);
	}, pricing => {
		// Pi's split-summary usage merger drops extension fields. Keep provenance
		// on the session branch as well, without counting the usage twice.
		pi.appendEntry("magpie-pricing", { pricing });
	}, preserveScope);
	const credential = readStoredCredential("magpie");
	// Validate saved configuration outside the best-effort network refresh.
	if (credential?.type === "api_key") readConfig({ ...process.env, ...credential.env, MAGPIE_API_KEY: credential.key ?? process.env.MAGPIE_API_KEY });
	try {
		// Match Pi's CLI flag semantics; --offline normalizes PI_OFFLINE to "1" before loading.
		const offline = ["1", "true", "yes"].includes(process.env.PI_OFFLINE?.toLowerCase() ?? "");
		const context = { credential, allowNetwork: false, signal: new AbortController().signal,
			publish: async ({ update }: { update?: () => void }) => { update?.(); return true; } };
		await provider.refreshModels!(context);
		if (!offline) await provider.refreshModels!({ ...context, allowNetwork: true });
	} catch {
		// Optional gateway may be stopped. /model retries and reports discovery errors.
	}
	pi.registerProvider(provider);
	pi.registerCommand("magpie-refresh", {
		description: "Refresh Magpie's model list immediately",
		async handler(_args, ctx) {
			try {
				const result = await ctx.modelRegistry.refresh({
					providers: ["magpie"], allowNetwork: true, force: true, signal: ctx.signal,
				});
				if (result.aborted) {
					ctx.ui.notify("Magpie model refresh cancelled.", "warning");
					return;
				}
				if (result.errors.has("magpie")) throw new Error("Magpie refresh failed");
				const count = selectMagpiePickerModels(ctx.modelRegistry.getAll().filter(model => model.provider === "magpie"), preserveScope()).length;
				ctx.ui.notify(count
					? `Magpie model list refreshed: ${count} model${count === 1 ? "" : "s"}.`
					: "No Magpie models available. Configure the gateway with /login magpie, then retry /magpie-refresh.",
					count ? "info" : "warning");
			} catch {
				ctx.ui.notify("Magpie model refresh failed; check gateway availability, /login magpie credentials, and models.json configuration.", "error");
			}
		},
	});
	registerMagpieCompaction(pi);
}
