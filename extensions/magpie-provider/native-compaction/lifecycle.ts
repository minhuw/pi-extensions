import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { resolveMagpieAlias } from "../model-aliases.ts";
import {
	buildCompactHeaders,
	buildCompactRequestBody,
	callRemoteCompaction,
	effectiveInputForBranch,
	findNativeCheckpoint,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	resolveCompactUrl,
	shouldFallbackToBuiltinCompaction,
	type CheckpointLookup,
	type NativeCompactionDetails,
	type ResponseItem,
} from "./native-compaction.ts";

const MAGPIE_PROVIDER_ID = "magpie";
const MAGPIE_RESPONSES_API = "openai-responses";
const MAGPIE_COMPACTION_COMMAND = "magpie-native-compaction";
const MAGPIE_COMPACTION_LABEL = "Magpie";

export interface MagpieCompactionConfig {
	enabled: boolean;
	models: string[];
	/** When native compact fails and the session has no native checkpoint, let Pi's built-in summarizer run. */
	fallbackToBuiltin: boolean;
}

export function isEligibleModel(
	model: { provider?: unknown; api?: unknown; id?: unknown } | undefined,
	config: MagpieCompactionConfig,
): boolean {
	return Boolean(
		config.enabled &&
		model &&
		model.provider === MAGPIE_PROVIDER_ID &&
		model.api === MAGPIE_RESPONSES_API &&
		typeof model.id === "string" &&
		config.models.includes(model.id),
	);
}

function localMarker(): string {
	return `${MAGPIE_COMPACTION_LABEL} native compaction checkpoint (${randomUUID()}).`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export function registerNativeCompaction(
	pi: ExtensionAPI,
	loadConfig: (ctx: ExtensionContext) => MagpieCompactionConfig,
): void {
	const activeModel = (ctx: ExtensionContext): Model<any> | undefined =>
		ctx.model ? resolveMagpieAlias(ctx.model) : undefined;
	const inScope = (ctx: ExtensionContext, checkpoint: CheckpointLookup): boolean => {
		const model = activeModel(ctx);
		// Guard corrupt/foreign history even when its original provider extension is no longer loaded.
		return checkpoint.status === "invalid" ||
			(checkpoint.status === "valid" && (!model || checkpoint.checkpoint.details.modelKey !== modelKey(model))) ||
			model?.provider === MAGPIE_PROVIDER_ID ||
			(checkpoint.status === "valid" &&
				checkpoint.checkpoint.details.modelKey.split(":")[0] === MAGPIE_PROVIDER_ID);
	};

	const createNativeCheckpoint = async (params: {
		ctx: ExtensionContext;
		model: Model<any>;
		input: ResponseItem[];
		signal?: AbortSignal;
	}): Promise<{ details: NativeCompactionDetails; usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"] }> => {
		const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(auth.ok ? `${MAGPIE_COMPACTION_LABEL} authentication is unavailable.` : auth.error);
		}
		const sessionId = params.ctx.sessionManager.getSessionId();
		const endpoint = resolveCompactUrl(auth.baseUrl ?? params.model.baseUrl);
		const remote = await callRemoteCompaction({
			url: endpoint,
			headers: buildCompactHeaders({ apiKey: auth.apiKey, headers: auth.headers, sessionId }),
			body: buildCompactRequestBody(params.model, params.input),
			model: params.model,
			signal: params.signal,
		});
		return {
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: modelKey(params.model),
				endpoint: "responses",
				replacementHistory: remote.replacementHistory,
			},
			usage: remote.usage,
		};
	};

	pi.on("context", (event, ctx) => {
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch());
		if (checkpoint.status === "none") return undefined;
		if (!inScope(ctx, checkpoint)) return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_request", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const checkpoint = findNativeCheckpoint(branch);
		if (checkpoint.status === "none") return undefined;

		const model = activeModel(ctx);
		try {
			if (!inScope(ctx, checkpoint)) return undefined;
			if (!model) throw new Error("No active model is selected.");
			const input = effectiveInputForBranch({ branch, model, tools: pi.getAllTools() });
			if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
				throw new Error("The provider request payload is not an object.");
			}
			const payload: Record<string, unknown> = { ...(event.payload as Record<string, unknown>), input };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		} catch (error) {
			ctx.abort();
			notify(ctx, `${MAGPIE_COMPACTION_LABEL} native-compaction request blocked: ${errorMessage(error)}`, "error");
			if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
			const payload: Record<string, unknown> = { ...(event.payload as Record<string, unknown>), input: [] };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = activeModel(ctx);
		let config: MagpieCompactionConfig;
		try {
			config = loadConfig(ctx);
		} catch (error) {
			// Pi swallows thrown hook errors, which would otherwise permit unsafe built-in fallback.
			notify(ctx, `${MAGPIE_COMPACTION_LABEL} native compaction configuration failed: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
		const checkpoint = findNativeCheckpoint(event.branchEntries);
		if (!inScope(ctx, checkpoint)) return undefined;

		if (!model || !isEligibleModel(model, config)) {
			if (checkpoint.status === "none") return undefined;
			notify(
				ctx,
				"This session contains a native Responses checkpoint. Select its original model and enable native compaction for it before compacting.",
				"error",
			);
			return { cancel: true };
		}

		try {
			if (event.customInstructions?.trim()) {
				notify(ctx, "Custom summary instructions are ignored by the native Responses compaction protocol.", "warning");
			}
			const input = effectiveInputForBranch({
				branch: event.branchEntries,
				model,
				tools: pi.getAllTools(),
				excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
			});
			const native = await createNativeCheckpoint({
				ctx,
				model,
				input,
				signal: event.signal,
			});
			notify(ctx, `${MAGPIE_COMPACTION_LABEL} native compaction complete (${native.details.replacementHistory.length} canonical items).`, "info");
			return {
				compaction: {
					summary: localMarker(),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: native.usage,
					details: native.details,
				},
			};
		} catch (error) {
			if (event.signal.aborted) return { cancel: true };
			if (shouldFallbackToBuiltinCompaction({ checkpoint, fallbackToBuiltin: config.fallbackToBuiltin })) {
				notify(
					ctx,
					`${MAGPIE_COMPACTION_LABEL} native compaction failed; falling back to Pi's built-in summarizer. ${errorMessage(error)}`,
					"warning",
				);
				return undefined;
			}
			notify(ctx, `${MAGPIE_COMPACTION_LABEL} native compaction failed: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
	});

	pi.registerCommand(MAGPIE_COMPACTION_COMMAND, {
		description: `Show whether native ${MAGPIE_COMPACTION_LABEL} compaction is active for the selected model.`,
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: MAGPIE_COMPACTION_COMMAND, kind: "extension", extension: "magpie-provider" });
			if (args.trim()) {
				ctx.ui.notify(`Usage: /${MAGPIE_COMPACTION_COMMAND}`, "error");
				return;
			}
			const config = loadConfig(ctx);
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			const model = activeModel(ctx);
			const enabled = isEligibleModel(model, config);
			ctx.ui.notify(
				`${enabled ? "Enabled" : "Disabled"} for ${selected}. Fallback to built-in: ${config.fallbackToBuiltin ? "on" : "off"}. Allowlist: ${config.models.join(", ") || "(empty)"}.`,
				enabled ? "info" : "warning",
			);
		},
	});
}
