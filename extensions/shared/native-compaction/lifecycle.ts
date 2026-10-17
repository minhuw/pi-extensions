import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { isEligibleModel, type NativeCompactionConfig } from "./types.ts";
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

function localMarker(label: string): string {
	return `${label} native compaction checkpoint (${randomUUID()}).`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export interface NativeCompactionOptions {
	loadConfig: (ctx: ExtensionContext) => NativeCompactionConfig;
	ownsProvider: (providerId: string, config: NativeCompactionConfig) => boolean;
	command: string;
	label: string;
}

export function registerNativeCompaction(pi: ExtensionAPI, options: NativeCompactionOptions): void {
	const inScope = (ctx: ExtensionContext, checkpoint: CheckpointLookup, config: NativeCompactionConfig): boolean =>
		// Guard corrupt/foreign history even when its original provider extension is no longer loaded.
		checkpoint.status === "invalid" ||
		(checkpoint.status === "valid" && (!ctx.model || checkpoint.checkpoint.details.modelKey !== modelKey(ctx.model))) ||
		Boolean(ctx.model && options.ownsProvider(ctx.model.provider, config)) ||
		(checkpoint.status === "valid" &&
			options.ownsProvider(checkpoint.checkpoint.details.modelKey.split(":")[0]!, config));

	const createNativeCheckpoint = async (params: {
		ctx: ExtensionContext;
		model: Model<any>;
		input: ResponseItem[];
		config: NativeCompactionConfig;
		signal?: AbortSignal;
	}): Promise<{ details: NativeCompactionDetails; usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"] }> => {
		const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(auth.ok ? `${options.label} authentication is unavailable.` : auth.error);
		}
		const sessionId = params.ctx.sessionManager.getSessionId();
		const endpoint = resolveCompactUrl(auth.baseUrl ?? params.model.baseUrl, params.config.endpoint);
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
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status === "none") return undefined;
		if (!inScope(ctx, checkpoint, options.loadConfig(ctx))) return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_request", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const checkpoint = findNativeCheckpoint(branch);
		if (checkpoint.status === "none") return undefined;

		const model = ctx.model;
		try {
			if (!inScope(ctx, checkpoint, options.loadConfig(ctx))) return undefined;
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
			notify(ctx, `${options.label} native-compaction request blocked: ${errorMessage(error)}`, "error");
			if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
			const payload: Record<string, unknown> = { ...(event.payload as Record<string, unknown>), input: [] };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		let config: NativeCompactionConfig;
		try {
			config = options.loadConfig(ctx);
		} catch (error) {
			// Pi swallows thrown hook errors, which would otherwise permit unsafe built-in fallback.
			notify(ctx, `${options.label} native compaction configuration failed: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
		const checkpoint = findNativeCheckpoint(event.branchEntries as SessionEntry[]);
		if (!inScope(ctx, checkpoint, config)) return undefined;

		if (!model || !options.ownsProvider(model.provider, config) || !isEligibleModel(model, config)) {
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
				branch: event.branchEntries as SessionEntry[],
				model,
				tools: pi.getAllTools(),
				excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
			});
			const native = await createNativeCheckpoint({
				ctx,
				model,
				input,
				config,
				signal: event.signal,
			});
			notify(ctx, `${options.label} native compaction complete (${native.details.replacementHistory.length} canonical items).`, "info");
			return {
				compaction: {
					summary: localMarker(options.label),
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
					`${options.label} native compaction failed; falling back to Pi's built-in summarizer. ${errorMessage(error)}`,
					"warning",
				);
				return undefined;
			}
			notify(ctx, `${options.label} native compaction failed: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
	});

	pi.registerCommand(options.command, {
		description: `Show whether native ${options.label} compaction is active for the selected model.`,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(`Usage: /${options.command}`, "error");
				return;
			}
			const config = options.loadConfig(ctx);
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			const enabled = Boolean(ctx.model && options.ownsProvider(ctx.model.provider, config) && isEligibleModel(ctx.model, config));
			ctx.ui.notify(
				`${enabled ? "Enabled" : "Disabled"} for ${selected}. Fallback to built-in: ${config.fallbackToBuiltin ? "on" : "off"}. Allowlist: ${config.models.join(", ") || "(empty)"}.`,
				enabled ? "info" : "warning",
			);
		},
	});
}
