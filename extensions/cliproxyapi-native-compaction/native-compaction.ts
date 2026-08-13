import { createHash } from "node:crypto";
import {
	buildSessionContext,
	convertToLlm,
	sessionEntryToContextMessages,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Message, type Model, type Usage } from "@earendil-works/pi-ai";

export const NATIVE_COMPACTION_KIND = "cliproxyapi-openai-native-compaction";
export const LEGACY_NATIVE_COMPACTION_VERSION = 1;
export const NATIVE_COMPACTION_VERSION = 2;
export const OPAQUE_COMPACTION_TYPES = new Set(["compaction", "compaction_summary"]);
const REMOTE_COMPACTION_V2_RETAINED_TOKEN_BUDGET = 64_000;
const REMOTE_COMPACTION_V2_MAX_AGENT_MESSAGE_TOKENS = 10_000;
const MAX_REMOTE_RETRIES = 2;

export type JsonObject = Record<string, unknown>;
export type ResponseItem = JsonObject & { type?: string };

export type NativeCompactionDetails = {
	kind: typeof NATIVE_COMPACTION_KIND;
	modelKey: string;
	replacementHistory: ResponseItem[];
} &
	(
		| { version: typeof LEGACY_NATIVE_COMPACTION_VERSION; endpoint: "responses/compact" }
		| { version: typeof NATIVE_COMPACTION_VERSION; endpoint: "responses" }
	);

export type NativeCheckpoint = {
	entryIndex: number;
	entryId: string;
	details: NativeCompactionDetails;
};

export type CheckpointLookup =
	| { status: "none" }
	| { status: "invalid"; entryIndex: number; entryId: string }
	| { status: "valid"; checkpoint: NativeCheckpoint };

export interface CompactResponse {
	output: ResponseItem[];
	usage?: unknown;
}

export interface RemoteCompactionResult {
	replacementHistory: ResponseItem[];
	usage?: Usage;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

export function normalizeResponseInputItem(item: ResponseItem): ResponseItem {
	const normalized = clone(item);
	// Compaction rejects output-only status on replayed message and reasoning
	// items, even though ordinary Responses turns may accept it.
	if (normalized.type === "message" || normalized.type === "reasoning") {
		delete normalized.status;
	}
	return normalized;
}

export function modelKey(model: Pick<Model<any>, "provider" | "api" | "id">): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

export function isResponseItem(value: unknown): value is ResponseItem {
	if (!isJsonObject(value)) return false;
	return (
		typeof value.type === "string" ||
		(typeof value.role === "string" && (typeof value.content === "string" || Array.isArray(value.content)))
	);
}

export function isOpaqueCompactionItem(value: unknown): value is ResponseItem {
	return (
		isResponseItem(value) &&
		typeof value.type === "string" &&
		OPAQUE_COMPACTION_TYPES.has(value.type) &&
		typeof value.encrypted_content === "string" &&
		value.encrypted_content.length > 0
	);
}

export function validateReplacementHistory(value: unknown): ResponseItem[] {
	if (!Array.isArray(value) || value.length === 0 || !value.every(isResponseItem)) {
		throw new Error("CLIProxyAPI returned an invalid or empty compacted output window.");
	}
	const opaqueItems = value.filter(isOpaqueCompactionItem);
	if (opaqueItems.length !== 1) {
		throw new Error(
			`CLIProxyAPI returned ${opaqueItems.length} opaque compaction items; expected exactly one.`,
		);
	}
	return value.map(clone);
}

export function parseCompactResponse(value: unknown): CompactResponse {
	if (!isJsonObject(value)) throw new Error("CLIProxyAPI returned a non-object compact response.");
	return {
		output: validateReplacementHistory(value.output),
		usage: value.usage,
	};
}

function approximateInputTokens(value: unknown): number {
	if (typeof value === "string") {
		return value.startsWith("data:image/") ? 1024 : Math.ceil(value.length / 4);
	}
	if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + approximateInputTokens(entry), 0);
	if (!isJsonObject(value)) return 0;
	return Object.values(value).reduce<number>((total, entry) => total + approximateInputTokens(entry), 0);
}

function userContentPartTokens(part: unknown): number {
	if (!isJsonObject(part)) return 0;
	if (typeof part.text === "string") return Math.ceil(part.text.length / 4);
	if (typeof part.image_url === "string" || typeof part.data === "string") return 1024;
	return approximateInputTokens(part);
}

function userMessageTokens(item: ResponseItem): number {
	if (typeof item.content === "string") return Math.ceil(item.content.length / 4);
	if (!Array.isArray(item.content)) return 0;
	return item.content.reduce<number>((total, part) => total + userContentPartTokens(part), 0);
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
	return text.slice(0, Math.max(0, maxTokens) * 4);
}

function truncateRetainedUserItem(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
	const truncated = clone(item);
	if (typeof truncated.content === "string") {
		truncated.content = truncateTextToTokenBudget(truncated.content, maxTokens);
		return truncated.content ? truncated : undefined;
	}
	if (!Array.isArray(truncated.content)) return undefined;

	let remaining = maxTokens;
	const content: unknown[] = [];
	for (const part of truncated.content) {
		if (remaining <= 0) continue;
		const tokens = userContentPartTokens(part);
		if (!isJsonObject(part) || typeof part.text !== "string") {
			if (tokens <= remaining) {
				content.push(part);
				remaining -= tokens;
			}
			continue;
		}
		if (tokens <= remaining) {
			content.push(part);
			remaining -= tokens;
			continue;
		}
		const text = truncateTextToTokenBudget(part.text, remaining);
		if (text) content.push({ ...part, text });
		remaining = 0;
	}
	truncated.content = content;
	return content.length > 0 ? truncated : undefined;
}

function isRetainedRemoteCompactionV2Item(item: ResponseItem): boolean {
	if (item.role === "user") return true;
	if (item.type !== "agent_message") return false;
	if (approximateInputTokens(item) > REMOTE_COMPACTION_V2_MAX_AGENT_MESSAGE_TOKENS) return false;
	const content = Array.isArray(item.content) ? item.content : [];
	const first = content[0];
	return !(
		isJsonObject(first) &&
		typeof first.text === "string" &&
		first.text.startsWith("Message Type: FINAL_ANSWER\n")
	);
}

export function buildRemoteCompactionV2ReplacementHistory(
	input: ResponseItem[],
	output: ResponseItem[],
): ResponseItem[] {
	const canonicalOutput = validateReplacementHistory(output);
	const compactionItem = canonicalOutput.find(isOpaqueCompactionItem)!;
	const retainedReversed: ResponseItem[] = [];
	let remaining = REMOTE_COMPACTION_V2_RETAINED_TOKEN_BUDGET;
	for (let index = input.length - 1; index >= 0 && remaining > 0; index--) {
		const item = input[index];
		if (!item || !isRetainedRemoteCompactionV2Item(item)) continue;
		const tokens = Math.max(1, item.role === "user" ? userMessageTokens(item) : approximateInputTokens(item));
		if (tokens <= remaining) {
			retainedReversed.push(clone(item));
			remaining -= tokens;
			continue;
		}
		if (item.role === "user") {
			const truncated = truncateRetainedUserItem(item, remaining);
			if (truncated) retainedReversed.push(truncated);
			remaining = 0;
		}
	}
	retainedReversed.reverse();
	return [...retainedReversed, clone(compactionItem)];
}

export function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isJsonObject(value) || value.kind !== NATIVE_COMPACTION_KIND || typeof value.modelKey !== "string") {
		return undefined;
	}
	try {
		const common: Pick<NativeCompactionDetails, "kind" | "modelKey" | "replacementHistory"> = {
			kind: NATIVE_COMPACTION_KIND,
			modelKey: value.modelKey,
			replacementHistory: validateReplacementHistory(value.replacementHistory),
		};
		if (value.version === LEGACY_NATIVE_COMPACTION_VERSION && value.endpoint === "responses/compact") {
			return { ...common, version: LEGACY_NATIVE_COMPACTION_VERSION, endpoint: "responses/compact" };
		}
		if (value.version === NATIVE_COMPACTION_VERSION && value.endpoint === "responses") {
			return { ...common, version: NATIVE_COMPACTION_VERSION, endpoint: "responses" };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function findNativeCheckpoint(branch: SessionEntry[]): CheckpointLookup {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;

		let rawDetails: unknown;
		if (entry.type === "compaction") {
			if (!isJsonObject(entry.details) || entry.details.kind !== NATIVE_COMPACTION_KIND) {
				return { status: "none" };
			}
			rawDetails = entry.details;
		} else if (entry.type === "custom" && entry.customType === NATIVE_COMPACTION_KIND) {
			rawDetails = entry.data;
		} else {
			continue;
		}

		const details = parseNativeCompactionDetails(rawDetails);
		if (!details) return { status: "invalid", entryIndex: index, entryId: entry.id };
		return {
			status: "valid",
			checkpoint: { entryIndex: index, entryId: entry.id, details },
		};
	}
	return { status: "none" };
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedItemId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
	return sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`.slice(0, 64);
}

function textSignature(value: unknown): { id?: string; phase?: "commentary" | "final_answer" } {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isJsonObject(parsed)) return {};
		return {
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			phase: parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined,
		};
	} catch {
		return { id: value };
	}
}

function contentToUserParts(content: unknown): unknown[] {
	if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: unknown[] = [];
	for (const part of content) {
		if (!isJsonObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "input_text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			parts.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${part.mimeType};base64,${part.data}`,
			});
		}
	}
	return parts;
}

function toolResultOutput(message: JsonObject, model: Model<any>): unknown {
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.flatMap((part) => (isJsonObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
	const images = content.filter((part) => isJsonObject(part) && part.type === "image");
	if (images.length === 0 || !model.input.includes("image")) {
		return text || (images.length > 0 ? "(see attached image)" : "(no tool output)");
	}
	return [
		...(text ? [{ type: "input_text", text }] : []),
		...images.flatMap((part) =>
			typeof part.data === "string" && typeof part.mimeType === "string"
				? [{ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` }]
				: [],
		),
	];
}

function responseTool(tool: ToolInfo, deferLoading = false): JsonObject {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown,
		strict: null,
		...(deferLoading ? { defer_loading: true } : {}),
	};
}

export function messagesToResponseItems(model: Model<any>, messages: Message[], tools: ToolInfo[]): ResponseItem[] {
	const items: ResponseItem[] = [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const pendingToolCalls = new Map<string, string>();
	const flushOrphanedToolCalls = () => {
		for (const callId of pendingToolCalls.values()) {
			items.push({ type: "function_call_output", call_id: callId, output: "No result provided" });
		}
		pendingToolCalls.clear();
	};
	let messageIndex = 0;

	for (const message of messages as unknown as JsonObject[]) {
		if (message.role === "user") {
			flushOrphanedToolCalls();
			const content = contentToUserParts(message.content);
			if (content.length > 0) items.push({ role: "user", content });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			flushOrphanedToolCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				messageIndex++;
				continue;
			}
			let textIndex = 0;
			for (const block of message.content) {
				if (!isJsonObject(block)) continue;
				if (block.type === "thinking" && typeof block.thinkingSignature === "string") {
					try {
						const reasoning: unknown = JSON.parse(block.thinkingSignature);
						if (isJsonObject(reasoning) && reasoning.type === "reasoning") {
							items.push(normalizeResponseInputItem(reasoning));
						}
					} catch {
						// A missing/legacy reasoning signature cannot be replayed.
					}
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					const signature = textSignature(block.textSignature);
					const fallbackId = textIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textIndex}`;
					textIndex++;
					const rawId = signature.id || fallbackId;
					const id = rawId.length <= 64 ? rawId : `msg_${shortHash(rawId)}`;
					items.push({
						type: "message",
						role: "assistant",
						id,
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						...(signature.phase ? { phase: signature.phase } : {}),
					});
					continue;
				}
				if (block.type === "toolCall" && typeof block.id === "string") {
					const [callId, rawItemId] = block.id.split("|");
					pendingToolCalls.set(block.id, callId);
					items.push({
						type: "function_call",
						call_id: callId,
						...(normalizedItemId(rawItemId) ? { id: normalizedItemId(rawItemId) } : {}),
						name: String(block.name ?? ""),
						arguments: JSON.stringify(block.arguments ?? {}),
					});
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const [callId] = message.toolCallId.split("|");
			pendingToolCalls.delete(message.toolCallId);
			items.push({ type: "function_call_output", call_id: callId, output: toolResultOutput(message, model) });

			const addedTools = Array.isArray(message.addedToolNames)
				? message.addedToolNames.flatMap((name) =>
					typeof name === "string" && toolsByName.has(name) ? [toolsByName.get(name)!] : [],
				)
				: [];
			if (addedTools.length > 0) {
				const searchCallId = `pi_tool_load_${shortHash(`${message.toolCallId}:${addedTools.map((tool) => tool.name).join(",")}`)}`;
				items.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: addedTools.map((tool) => tool.name).join(" "), limit: addedTools.length },
				});
				items.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: addedTools.map((tool) => responseTool(tool, true)),
				});
			}
		}
		messageIndex++;
	}
	flushOrphanedToolCalls();
	return items;
}

function entriesToResponseItems(model: Model<any>, entries: SessionEntry[], tools: ToolInfo[]): ResponseItem[] {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messagesToResponseItems(model, convertToLlm(messages), tools);
}

export function effectiveInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<any>;
	tools: ToolInfo[];
	excludeLastAssistantError?: boolean;
}): ResponseItem[] {
	let branch = params.branch;
	if (params.excludeLastAssistantError) {
		const lastAssistantIndex = branch.findLastIndex(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (lastAssistantIndex >= 0) branch = branch.filter((_entry, index) => index !== lastAssistantIndex);
	}

	const checkpoint = findNativeCheckpoint(branch);
	if (checkpoint.status === "invalid") {
		throw new Error("The latest CLIProxyAPI native compaction checkpoint is malformed.");
	}
	if (checkpoint.status === "valid") {
		if (checkpoint.checkpoint.details.modelKey !== modelKey(params.model)) {
			throw new Error("The latest native compaction checkpoint belongs to a different model.");
		}
		const tail = branch.slice(checkpoint.checkpoint.entryIndex + 1);
		return [
			...checkpoint.checkpoint.details.replacementHistory.map(normalizeResponseInputItem),
			...entriesToResponseItems(params.model, tail, params.tools),
		];
	}

	const context = buildSessionContext(branch);
	return messagesToResponseItems(params.model, convertToLlm(context.messages), params.tools);
}

export function resolveCompactUrl(baseUrl: string | undefined, configuredEndpoint?: string): string {
	if (configuredEndpoint?.trim()) {
		const endpoint = configuredEndpoint.trim().replace(/\/+$/, "");
		if (endpoint.endsWith("/responses/compact")) {
			throw new Error("The legacy /responses/compact endpoint is unsafe with CLIProxyAPI; configure the normal /responses endpoint.");
		}
		return endpoint;
	}
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	if (!normalized) throw new Error("The CLIProxyAPI model has no base URL.");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/backend-api")) return `${normalized}/codex/responses`;
	if (normalized.endsWith("/v1")) return `${normalized}/responses`;
	return `${normalized}/backend-api/codex/responses`;
}

export function buildCompactHeaders(params: {
	apiKey: string;
	headers?: Record<string, string | null | undefined>;
	sessionId: string;
}): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(params.headers ?? {})) {
		if (typeof value === "string") headers.set(name, value);
	}
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	headers.set("originator", "pi");
	headers.set("user-agent", "pi-cliproxyapi-native-compaction");
	headers.set("x-codex-beta-features", "remote_compaction_v2");
	headers.set("session-id", params.sessionId);
	headers.set("x-client-request-id", params.sessionId);
	// A plain CLIProxyAPI key is not a ChatGPT JWT, so never synthesize chatgpt-account-id.
	headers.delete("chatgpt-account-id");
	return headers;
}

export function buildCompactRequestBody(model: Model<any>, input: ResponseItem[]): JsonObject {
	return {
		model: model.id,
		instructions: "",
		input: [...input.map(normalizeResponseInputItem), { type: "compaction_trigger" }],
	};
}

export function isAuthUnavailableMessage(value: string): boolean {
	return /auth_unavailable|no auth available/i.test(value);
}

export function shouldFallbackToBuiltinCompaction(params: {
	checkpoint: CheckpointLookup;
	fallbackToBuiltin: boolean;
}): boolean {
	return params.fallbackToBuiltin && params.checkpoint.status === "none";
}

function parseRetryDelay(response: Response): number | undefined {
	const milliseconds = Number(response.headers.get("retry-after-ms"));
	if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

class NonRetryableCompactionError extends Error {}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Compaction aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function usageFromResponse(model: Model<any>, value: unknown): Usage | undefined {
	if (!isJsonObject(value)) return undefined;
	const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
	const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
	const details = isJsonObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
	const cacheWrite = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

export async function callRemoteCompaction(params: {
	url: string;
	headers: Headers;
	body: JsonObject;
	model: Model<any>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<RemoteCompactionResult> {
	const fetchImpl = params.fetchImpl ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_REMOTE_RETRIES; attempt++) {
		try {
			const response = await fetchImpl(params.url, {
				method: "POST",
				headers: params.headers,
				body: JSON.stringify(params.body),
				signal: params.signal,
			});
			if (!response.ok) {
				const responseBody = await response.text().catch(() => "");
				const message = `CLIProxyAPI native compaction failed (${response.status}): ${responseBody || response.statusText}`;
				// auth_unavailable is a routing/auth-selection miss. Repeating the same bound request will not recover.
				if (!isRetryableStatus(response.status) || isAuthUnavailableMessage(responseBody) || isAuthUnavailableMessage(message)) {
					throw new NonRetryableCompactionError(message);
				}
				const error = new Error(message);
				if (attempt === MAX_REMOTE_RETRIES) throw error;
				lastError = error;
				await delay(parseRetryDelay(response) ?? 1000 * 2 ** attempt, params.signal);
				continue;
			}
			const parsed = parseCompactResponse(await response.json());
			const input = Array.isArray(params.body.input)
				? (params.body.input as unknown[]).filter(isResponseItem).filter((item) => item.type !== "compaction_trigger")
				: [];
			return {
				replacementHistory: buildRemoteCompactionV2ReplacementHistory(input, parsed.output),
				usage: usageFromResponse(params.model, parsed.usage),
			};
		} catch (error) {
			if (params.signal?.aborted || error instanceof NonRetryableCompactionError) throw error;
			lastError = error;
			if (attempt === MAX_REMOTE_RETRIES) throw error;
			await delay(1000 * 2 ** attempt, params.signal);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("CLIProxyAPI native compaction failed.");
}
