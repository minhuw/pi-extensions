/**
 * In-memory Prefix KV Cache telemetry and miss root-cause forensics for Pi's
 * statusline footer.
 *
 * Observes outgoing provider payloads (`before_provider_request`) and finalized
 * assistant usage (`message_end`) within a single interactive TUI session.
 * Never mutates payloads, performs no disk I/O, and never serializes raw prompt
 * text in reload snapshots.
 */

import { createHash } from "node:crypto";

export type WireApi = "openai-responses" | "anthropic-messages" | "openai-completions";

export type CacheCause =
	| "cold_start"
	| "below_min_tokens"
	| "healthy"
	| "warmup"
	| "usage_unavailable"
	| "model_changed"
	| "provider_strict_fallback"
	| "tools_mutated"
	| "system_mutated"
	| "history_rewritten"
	| "ttl_expired_likely"
	| "provider_miss_or_routing"
	| "partial_hit";

export interface WireFingerprint {
	api: WireApi;
	systemHash: string;
	/** Kept strictly in-memory for the previous wire only; never persisted. */
	systemText: string;
	systemBytes: number;
	toolsHash: string;
	toolHashes: Record<string, string>;
	hasStrictTools: boolean;
	nonStrictToolsHash: string;
	itemHashes: string[];
	modelInPayload: string | null;
	promptCacheKey: string | null;
	effort: string | null;
	fullRequestHash: string;
	retentionTtlSec: number | null;
	retentionActive: boolean;
}

export interface CacheCallRecord {
	callIndex: number;
	atMs: number;
	model: string | null;
	api: WireApi | null;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	totalPromptTokens: number;
	hitPct: number | null;
	cause: CacheCause;
	tag: string | null;
	isAnomaly: boolean;
	detail: string | null;
	systemHash: string | null;
	toolsHash: string | null;
	itemCount: number | null;
}

export interface CacheAnomalyBadge {
	hitPct: number;
	tag: string;
	severity: "warning" | "error";
}

export interface CacheLensReloadSnapshot {
	calls: number;
	sessionPromptTotal: number;
	sessionCacheRead: number;
	sessionCacheWrite: number;
	hasBaseline: boolean;
	prevHitPct: number | null;
	prevModelKey: string | null;
	prevModelInPayload: string | null;
	prevSystemHash: string | null;
	prevSystemBytes: number | null;
	prevToolsHash: string | null;
	prevToolHashes: Record<string, string> | null;
	prevItemHashes: string[] | null;
	prevPromptCacheKey: string | null;
	lastCacheTouchAtMs: number | null;
	lastCacheTouchTtlSec: number | null;
	lastRecord: CacheCallRecord | null;
	records: CacheCallRecord[];
	anomalies: CacheCallRecord[];
}

export interface RecordRequestOptions {
	api?: string;
	modelKey?: string;
	nowMs?: number;
}

export interface AssistantMessageLike {
	role?: string;
	provider?: string;
	model?: string;
	api?: string;
	stopReason?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

const MIN_CACHEABLE_TOKENS = 1024;
const HEALTHY_HIT_PCT = 70;
const SHARP_DROP_PP = 35;
const WARMUP_MIN_HIT_PCT = 50;
const WARMUP_MAX_CALLS = 3;
const MAX_PENDING_CAPTURES = 8;
const MAX_RECORDS = 50;
const MAX_ANOMALIES = 25;
const SUMMARY_RECENT_LIMIT = 8;
const DEFAULT_RETENTION_TTL_SEC = 290;

const CAUSE_TAGS: Record<CacheCause, string | null> = {
	cold_start: "(cold)",
	below_min_tokens: "(<1k)",
	healthy: null,
	warmup: null,
	usage_unavailable: null,
	model_changed: "!model",
	provider_strict_fallback: "!strict",
	tools_mutated: "!tools",
	system_mutated: "!sys",
	history_rewritten: "!hist",
	ttl_expired_likely: "!ttl",
	provider_miss_or_routing: "!route",
	partial_hit: "!drop",
};

const VALID_CAUSES = new Set<string>(Object.keys(CAUSE_TAGS));
const VALID_APIS = new Set<string>(["openai-responses", "anthropic-messages", "openai-completions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Short(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 12);
}

/** Deterministic JSON serialization with sorted keys. */
function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? "null" : encoded;
	}
	if (seen.has(value)) return '"[Circular]"';
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const parts: string[] = [];
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				parts.push(item === undefined ? "null" : stableStringify(item, seen));
			}
			return `[${parts.join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		const entries: string[] = [];
		for (const key of keys) {
			const prop = record[key];
			if (prop === undefined) continue;
			entries.push(`${JSON.stringify(key)}:${stableStringify(prop, seen)}`);
		}
		return `{${entries.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

interface RetentionCollector {
	sawCacheControl: boolean;
	explicitTtls: number[];
}

function parseRetentionTtlSec(raw: unknown): number | null {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.round(raw);
	}
	if (typeof raw !== "string") return null;
	const norm = raw.trim().toLowerCase();
	if (!norm) return null;
	if (norm === "5m" || norm === "in-memory" || norm === "in_memory") return 290;
	if (norm === "30m") return 1800;
	if (norm === "1h") return 3600;
	if (norm === "24h") return 86400;
	const match = /^(\d+)(s|m|h)$/.exec(norm);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const unit = match[2];
	if (unit === "s") return amount;
	if (unit === "m") return amount * 60;
	return amount * 3600;
}

function noteCacheControl(value: unknown, collector: RetentionCollector): void {
	if (value === undefined || value === null) return;
	collector.sawCacheControl = true;
	if (isRecord(value)) {
		const ttl = parseRetentionTtlSec(value.ttl);
		if (ttl !== null) collector.explicitTtls.push(ttl);
	}
}

function omitWireKey(obj: Record<string, unknown>, keyToOmit: string, collector?: RetentionCollector): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (k === keyToOmit) {
			if (collector && keyToOmit === "cache_control") noteCacheControl(v, collector);
			continue;
		}
		out[k] = v;
	}
	return out;
}

function inferWireApi(payload: Record<string, unknown>, apiHint?: string): WireApi {
	if (typeof apiHint === "string" && apiHint.trim()) {
		const norm = apiHint.trim().toLowerCase();
		if (norm === "openai-responses" || norm.includes("responses")) return "openai-responses";
		if (norm === "anthropic-messages" || norm.includes("anthropic")) return "anthropic-messages";
		if (norm === "openai-completions" || norm.includes("completions")) return "openai-completions";
	}
	if (Array.isArray(payload.input) || typeof payload.input === "string" || typeof payload.instructions === "string") {
		return "openai-responses";
	}
	if (payload.system !== undefined) {
		return "anthropic-messages";
	}
	if (Array.isArray(payload.tools) && payload.tools.some(t => isRecord(t) && "input_schema" in t)) {
		return "anthropic-messages";
	}
	if (Array.isArray(payload.messages)) {
		for (const msg of payload.messages) {
			if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (isRecord(block) && (block.type === "tool_use" || block.type === "tool_result")) {
					return "anthropic-messages";
				}
			}
		}
	}
	return "openai-completions";
}

function isPlainSingleTextBlock(block: unknown): block is { type: "text"; text: string } {
	if (!isRecord(block)) return false;
	if (block.type !== "text" || typeof block.text !== "string") return false;
	for (const key of Object.keys(block)) {
		if (key !== "type" && key !== "text") return false;
	}
	return true;
}

/**
 * Canonicalizes a content array or string for rolling-breakpoint APIs
 * (`anthropic-messages` and `openai-completions`):
 * - Strips `cache_control` only on content-part envelopes and `tool_result.content` sub-blocks.
 * - Never touches tool call `input` or `arguments`.
 * - Collapses metadata-only single-text array wrappers `[{ type: "text", text }]` to plain string `text`.
 */
function canonicalizeMessageContent(
	content: unknown,
	collapseSingleText: boolean,
	collector: RetentionCollector,
): unknown {
	if (!Array.isArray(content)) return content;
	const canonicalParts = content.map(part => {
		if (!isRecord(part)) return part;
		const stripped = omitWireKey(part, "cache_control", collector);
		if (stripped.type === "tool_result" && Array.isArray(stripped.content)) {
			stripped.content = canonicalizeSubBlocks(stripped.content, collapseSingleText, collector);
		}
		return stripped;
	});
	if (collapseSingleText && canonicalParts.length === 1 && isPlainSingleTextBlock(canonicalParts[0])) {
		return canonicalParts[0].text;
	}
	return canonicalParts;
}

function canonicalizeSubBlocks(
	blocks: unknown[],
	collapseSingleText: boolean,
	collector: RetentionCollector,
): unknown {
	const canonical = blocks.map(block => (isRecord(block) ? omitWireKey(block, "cache_control", collector) : block));
	if (collapseSingleText && canonical.length === 1 && isPlainSingleTextBlock(canonical[0])) {
		return canonical[0].text;
	}
	return canonical;
}

function canonicalizeResponsesItem(item: unknown, collector: RetentionCollector): unknown {
	if (!isRecord(item)) return item;
	const stripped = omitWireKey(item, "cache_control", collector);
	if (Array.isArray(stripped.content)) {
		stripped.content = stripped.content.map(part =>
			isRecord(part) ? omitWireKey(part, "cache_control", collector) : part,
		);
	}
	return stripped;
}

function canonicalizeCompletionsOrAnthropicMessage(
	msg: unknown,
	collapseSingleText: boolean,
	collector: RetentionCollector,
): unknown {
	if (!isRecord(msg)) return msg;
	const stripped = omitWireKey(msg, "cache_control", collector);
	if (Array.isArray(stripped.content)) {
		stripped.content = canonicalizeMessageContent(stripped.content, collapseSingleText, collector);
	}
	return stripped;
}

function extractTextFromCanonicalContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : stableStringify(content);
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
			return stableStringify(part);
		})
		.join("\n");
}

function extractSystemAndItems(
	payload: Record<string, unknown>,
	api: WireApi,
	collector: RetentionCollector,
): { systemHash: string; systemText: string; systemBytes: number; itemHashes: string[] } {
	if (api === "openai-responses") {
		const rawInstructions = payload.instructions;
		let systemText = "";
		let systemCanonical: unknown = "";
		if (typeof rawInstructions === "string") {
			systemText = rawInstructions;
			systemCanonical = rawInstructions;
		} else if (Array.isArray(rawInstructions)) {
			const blocks = rawInstructions.map(b => (isRecord(b) ? omitWireKey(b, "cache_control", collector) : b));
			systemText = extractTextFromCanonicalContent(blocks);
			systemCanonical = blocks;
		} else if (rawInstructions !== undefined && rawInstructions !== null) {
			systemText = stableStringify(rawInstructions);
			systemCanonical = rawInstructions;
		}
		const systemHash = typeof systemCanonical === "string"
			? sha256Short(systemCanonical)
			: sha256Short(stableStringify(systemCanonical));
		const systemBytes = Buffer.byteLength(systemText, "utf8");

		let itemHashes: string[] = [];
		if (Array.isArray(payload.input)) {
			itemHashes = payload.input.map(item => sha256Short(stableStringify(canonicalizeResponsesItem(item, collector))));
		} else if (typeof payload.input === "string") {
			itemHashes = [sha256Short(stableStringify(payload.input))];
		}
		return { systemHash, systemText, systemBytes, itemHashes };
	}

	const collapseSingleText = api === "anthropic-messages" || api === "openai-completions";
	const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];

	let leadingSystemCount = 0;
	while (leadingSystemCount < rawMessages.length) {
		const msg = rawMessages[leadingSystemCount];
		if (!isRecord(msg)) break;
		const role = typeof msg.role === "string" ? msg.role : "";
		if (role === "system" || (api === "openai-completions" && role === "developer")) {
			leadingSystemCount++;
		} else {
			break;
		}
	}

	const leadingSystemMsgs = rawMessages
		.slice(0, leadingSystemCount)
		.map(msg => canonicalizeCompletionsOrAnthropicMessage(msg, collapseSingleText, collector));
	const conversationMsgs = rawMessages
		.slice(leadingSystemCount)
		.map(msg => canonicalizeCompletionsOrAnthropicMessage(msg, collapseSingleText, collector));

	let systemText = "";
	let systemHashInput = "";

	if (api === "anthropic-messages") {
		const rawSystem = payload.system;
		if (typeof rawSystem === "string") {
			systemText = rawSystem;
			systemHashInput = rawSystem;
		} else if (Array.isArray(rawSystem)) {
			const canonicalSystem = canonicalizeSubBlocks(rawSystem, collapseSingleText, collector);
			if (typeof canonicalSystem === "string") {
				systemText = canonicalSystem;
				systemHashInput = canonicalSystem;
			} else {
				systemText = extractTextFromCanonicalContent(canonicalSystem);
				systemHashInput = stableStringify(canonicalSystem);
			}
		} else if (leadingSystemMsgs.length > 0) {
			systemText = leadingSystemMsgs
				.map(m => (isRecord(m) ? extractTextFromCanonicalContent(m.content) : stableStringify(m)))
				.join("\n");
			systemHashInput = leadingSystemMsgs.length === 1 && isRecord(leadingSystemMsgs[0]) && typeof leadingSystemMsgs[0].content === "string"
				? leadingSystemMsgs[0].content
				: stableStringify(leadingSystemMsgs);
		}
	} else {
		// openai-completions
		if (leadingSystemMsgs.length > 0) {
			systemText = leadingSystemMsgs
				.map(m => (isRecord(m) ? extractTextFromCanonicalContent(m.content) : stableStringify(m)))
				.join("\n");
			systemHashInput = stableStringify(leadingSystemMsgs);
		}
	}

	const systemHash = sha256Short(systemHashInput);
	const systemBytes = Buffer.byteLength(systemText, "utf8");
	const itemHashes = conversationMsgs.map(msg => sha256Short(stableStringify(msg)));
	return { systemHash, systemText, systemBytes, itemHashes };
}

function canonicalizeTool(
	tool: unknown,
	stripStrict: boolean,
	collector?: RetentionCollector,
): { canonical: unknown; name: string | null; isStrict: boolean } {
	if (!isRecord(tool)) return { canonical: tool, name: null, isStrict: false };

	let isStrict = tool.strict === true;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(tool)) {
		if (k === "cache_control") {
			if (collector) noteCacheControl(v, collector);
			continue;
		}
		if (stripStrict && k === "strict") continue;
		if (k === "function" && isRecord(v)) {
			if (v.strict === true) isStrict = true;
			const fnOut: Record<string, unknown> = {};
			for (const [fk, fv] of Object.entries(v)) {
				if (fk === "cache_control") {
					if (collector) noteCacheControl(fv, collector);
					continue;
				}
				if (stripStrict && fk === "strict") continue;
				fnOut[fk] = fv;
			}
			out[k] = fnOut;
			continue;
		}
		out[k] = v;
	}

	let name: string | null = null;
	if (typeof tool.name === "string" && tool.name) {
		name = tool.name;
	} else if (isRecord(tool.function) && typeof tool.function.name === "string" && tool.function.name) {
		name = tool.function.name;
	} else if (typeof tool.type === "string" && tool.type) {
		name = tool.type;
	}
	return { canonical: out, name, isStrict };
}

function extractTools(
	payload: Record<string, unknown>,
	collector: RetentionCollector,
): {
	toolsHash: string;
	toolHashes: Record<string, string>;
	hasStrictTools: boolean;
	nonStrictToolsHash: string;
} {
	const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
	if (rawTools.length === 0) {
		const emptyHash = sha256Short("[]");
		return {
			toolsHash: emptyHash,
			toolHashes: {},
			hasStrictTools: false,
			nonStrictToolsHash: emptyHash,
		};
	}

	const canonicalTools: unknown[] = [];
	const nonStrictTools: unknown[] = [];
	const toolHashes: Record<string, string> = {};
	let hasStrictTools = false;

	for (let i = 0; i < rawTools.length; i++) {
		const tool = rawTools[i];
		const withStrict = canonicalizeTool(tool, false, collector);
		const withoutStrict = canonicalizeTool(tool, true);
		if (withStrict.isStrict) hasStrictTools = true;
		canonicalTools.push(withStrict.canonical);
		nonStrictTools.push(withoutStrict.canonical);

		const baseName = withStrict.name ?? `tool#${i}`;
		let key = baseName;
		if (Object.hasOwn(toolHashes, key)) {
			let suffix = 2;
			while (Object.hasOwn(toolHashes, `${baseName}#${suffix}`)) suffix++;
			key = `${baseName}#${suffix}`;
		}
		toolHashes[key] = sha256Short(stableStringify(withStrict.canonical));
	}

	return {
		toolsHash: sha256Short(stableStringify(canonicalTools)),
		toolHashes,
		hasStrictTools,
		nonStrictToolsHash: sha256Short(stableStringify(nonStrictTools)),
	};
}

function extractEffort(payload: Record<string, unknown>): string | null {
	if (isRecord(payload.reasoning) && typeof payload.reasoning.effort === "string" && payload.reasoning.effort.trim()) {
		return payload.reasoning.effort.trim();
	}
	if (typeof payload.reasoning_effort === "string" && payload.reasoning_effort.trim()) {
		return payload.reasoning_effort.trim();
	}
	if (isRecord(payload.output_config) && typeof payload.output_config.effort === "string" && payload.output_config.effort.trim()) {
		return payload.output_config.effort.trim();
	}
	if (isRecord(payload.thinking)) {
		if (typeof payload.thinking.budget_tokens === "number") {
			return `budget:${payload.thinking.budget_tokens}`;
		}
		if (typeof payload.thinking.type === "string" && payload.thinking.type.trim()) {
			return payload.thinking.type.trim();
		}
	}
	return null;
}

export function fingerprintProviderPayload(payload: unknown, apiHint?: string): WireFingerprint {
	const record = isRecord(payload) ? payload : {};
	const api = inferWireApi(record, apiHint);
	const collector: RetentionCollector = { sawCacheControl: false, explicitTtls: [] };

	// Top-level cache_control (e.g. Anthropic automatic caching)
	if (record.cache_control !== undefined) {
		noteCacheControl(record.cache_control, collector);
	}

	// Explicit retention knobs
	const rawRetention = record.prompt_cache_retention ?? record.promptCacheRetention;
	const retentionFromField = parseRetentionTtlSec(rawRetention);
	if (retentionFromField !== null) collector.explicitTtls.push(retentionFromField);

	const rawCacheOptions = record.prompt_cache_options ?? record.promptCacheOptions;
	if (isRecord(rawCacheOptions)) {
		const ttl = parseRetentionTtlSec(rawCacheOptions.ttl);
		if (ttl !== null) collector.explicitTtls.push(ttl);
	}

	const { systemHash, systemText, systemBytes, itemHashes } = extractSystemAndItems(record, api, collector);
	const { toolsHash, toolHashes, hasStrictTools, nonStrictToolsHash } = extractTools(record, collector);

	const modelInPayload = typeof record.model === "string" && record.model.trim() ? record.model.trim() : null;
	const rawPromptCacheKey = record.prompt_cache_key ?? record.promptCacheKey;
	const promptCacheKey = typeof rawPromptCacheKey === "string" && rawPromptCacheKey.trim()
		? rawPromptCacheKey.trim()
		: null;
	const effort = extractEffort(record);

	let retentionTtlSec: number | null = null;
	if (collector.explicitTtls.length > 0) {
		retentionTtlSec = Math.max(...collector.explicitTtls);
	} else if (collector.sawCacheControl || promptCacheKey !== null) {
		retentionTtlSec = DEFAULT_RETENTION_TTL_SEC;
	}
	const retentionActive = retentionTtlSec !== null;

	const fullRequestHash = sha256Short(
		stableStringify({
			api,
			modelInPayload,
			promptCacheKey,
			effort,
			systemHash,
			toolsHash,
			itemHashes,
		}),
	);

	return {
		api,
		systemHash,
		systemText,
		systemBytes,
		toolsHash,
		toolHashes,
		hasStrictTools,
		nonStrictToolsHash,
		itemHashes,
		modelInPayload,
		promptCacheKey,
		effort,
		fullRequestHash,
		retentionTtlSec,
		retentionActive,
	};
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function findFirstStringDiff(a: string, b: string): { charIdx: number; byteIdx: number } {
	const minLen = Math.min(a.length, b.length);
	let charIdx = 0;
	while (charIdx < minLen && a.charCodeAt(charIdx) === b.charCodeAt(charIdx)) {
		charIdx++;
	}
	// Do not split a UTF-16 surrogate pair when measuring UTF-8 byte offset.
	if (charIdx > 0) {
		const prevCode = a.charCodeAt(charIdx - 1);
		if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
			charIdx--;
		}
	}
	const byteIdx = Buffer.byteLength(a.slice(0, charIdx), "utf8");
	return { charIdx, byteIdx };
}

function describeToolDiff(
	prev: Record<string, string> | null,
	curr: Record<string, string>,
	prevHash: string,
	currHash: string,
): string {
	if (!prev) return `${prevHash}->${currHash}`;
	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];

	for (const name of Object.keys(curr)) {
		if (!Object.hasOwn(prev, name)) {
			added.push(`+${name}`);
		} else if (prev[name] !== curr[name]) {
			modified.push(`~${name}`);
		}
	}
	for (const name of Object.keys(prev)) {
		if (!Object.hasOwn(curr, name)) {
			removed.push(`-${name}`);
		}
	}
	added.sort();
	removed.sort();
	modified.sort();

	const changes = [...added, ...removed, ...modified];
	if (changes.length === 0) {
		return `reordered (${prevHash}->${currHash})`;
	}
	const maxListed = 6;
	const listed = changes.slice(0, maxListed).join(", ");
	const overflow = changes.length > maxListed ? ` (+${changes.length - maxListed} more)` : "";
	return `${listed}${overflow} (${prevHash}->${currHash})`;
}

function findHistoryDivergence(prev: readonly string[], curr: readonly string[]): number | null {
	const limit = Math.min(prev.length, curr.length);
	for (let i = 0; i < limit; i++) {
		if (prev[i] !== curr[i]) return i;
	}
	if (curr.length < prev.length) return curr.length;
	return null;
}

function fmtCompactTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function shortModelName(model: string | null): string {
	if (!model) return "-";
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}

interface PendingCapture {
	fingerprint: WireFingerprint;
	modelKey: string | null;
	capturedAtMs: number;
	strictFallback: boolean;
}

export class CacheLensTracker {
	private calls = 0;
	private sessionPromptTotal = 0;
	private sessionCacheRead = 0;
	private sessionCacheWrite = 0;
	private hasBaseline = false;
	private prevHitPct: number | null = null;
	private prevModelKey: string | null = null;
	private prevModelInPayload: string | null = null;
	private prevSystemHash: string | null = null;
	/** Kept strictly in-memory for the previous wire only; never serialized. */
	private prevSystemText: string | null = null;
	private prevSystemBytes: number | null = null;
	private prevToolsHash: string | null = null;
	private prevToolHashes: Record<string, string> | null = null;
	private prevItemHashes: string[] | null = null;
	private prevPromptCacheKey: string | null = null;
	private lastCacheTouchAtMs: number | null = null;
	private lastCacheTouchTtlSec: number | null = null;
	private compactedSinceLastCall = false;
	private pendingCaptures: PendingCapture[] = [];
	private lastEvaluableRecord: CacheCallRecord | null = null;
	private records: CacheCallRecord[] = [];
	private anomalies: CacheCallRecord[] = [];

	recordRequest(payload: unknown, opts?: RecordRequestOptions): WireFingerprint {
		const fp = fingerprintProviderPayload(payload, opts?.api);
		const capturedAtMs = opts?.nowMs ?? Date.now();
		const prev = this.pendingCaptures.at(-1);

		const droppedStrictOnSameTurn = Boolean(
			prev &&
			prev.fingerprint.hasStrictTools &&
			!fp.hasStrictTools &&
			prev.fingerprint.systemHash === fp.systemHash &&
			prev.fingerprint.modelInPayload === fp.modelInPayload &&
			prev.fingerprint.nonStrictToolsHash === fp.nonStrictToolsHash &&
			arraysEqual(prev.fingerprint.itemHashes, fp.itemHashes),
		);

		const carriedStrictFallback = Boolean(
			prev?.strictFallback &&
			!fp.hasStrictTools &&
			prev.fingerprint.systemHash === fp.systemHash &&
			prev.fingerprint.modelInPayload === fp.modelInPayload &&
			prev.fingerprint.nonStrictToolsHash === fp.nonStrictToolsHash &&
			arraysEqual(prev.fingerprint.itemHashes, fp.itemHashes),
		);

		this.pendingCaptures.push({
			fingerprint: fp,
			modelKey: opts?.modelKey ?? null,
			capturedAtMs,
			strictFallback: droppedStrictOnSameTurn || carriedStrictFallback,
		});
		if (this.pendingCaptures.length > MAX_PENDING_CAPTURES) {
			this.pendingCaptures.shift();
		}
		return fp;
	}

	recordCompaction(): void {
		this.compactedSinceLastCall = true;
	}

	/** Clears wire comparison baselines (e.g. after branch navigation) while keeping session history. */
	resetBaseline(): void {
		this.hasBaseline = false;
		this.prevHitPct = null;
		this.prevModelKey = null;
		this.prevModelInPayload = null;
		this.prevSystemHash = null;
		this.prevSystemText = null;
		this.prevSystemBytes = null;
		this.prevToolsHash = null;
		this.prevToolHashes = null;
		this.prevItemHashes = null;
		this.prevPromptCacheKey = null;
		this.lastCacheTouchAtMs = null;
		this.lastCacheTouchTtlSec = null;
		this.compactedSinceLastCall = false;
		this.pendingCaptures = [];
	}

	/** Clears all in-memory telemetry and diagnostics for the current session. */
	reset(): void {
		this.calls = 0;
		this.sessionPromptTotal = 0;
		this.sessionCacheRead = 0;
		this.sessionCacheWrite = 0;
		this.lastEvaluableRecord = null;
		this.records = [];
		this.anomalies = [];
		this.resetBaseline();
	}

	recordMessageEnd(message: AssistantMessageLike, nowMs = Date.now()): CacheCallRecord | null {
		if (message.role !== "assistant") return null;

		const capture = this.pendingCaptures.at(-1) ?? null;
		const sawStrictFallback = this.pendingCaptures.some(c => c.strictFallback);
		this.pendingCaptures = [];
		const currFp = capture?.fingerprint ?? null;

		const inputTokens = Math.max(0, Number(message.usage?.input) || 0);
		const outputTokens = Math.max(0, Number(message.usage?.output) || 0);
		const cacheRead = Math.max(0, Number(message.usage?.cacheRead) || 0);
		const cacheWrite = Math.max(0, Number(message.usage?.cacheWrite) || 0);
		const totalPromptTokens = inputTokens + cacheRead + cacheWrite;

		const msgModelKey = message.provider && message.model
			? `${message.provider}/${message.model}`
			: message.model ?? null;
		const effectiveModel = msgModelKey ?? capture?.modelKey ?? currFp?.modelInPayload ?? null;

		if (totalPromptTokens <= 0) {
			const detail = message.stopReason === "error" || message.stopReason === "aborted"
				? `stopReason=${message.stopReason}`
				: "no prompt token usage";
			const record: CacheCallRecord = {
				callIndex: this.calls + 1,
				atMs: nowMs,
				model: effectiveModel,
				api: currFp?.api ?? null,
				inputTokens,
				outputTokens,
				cacheRead,
				cacheWrite,
				totalPromptTokens: 0,
				hitPct: null,
				cause: "usage_unavailable",
				tag: null,
				isAnomaly: false,
				detail,
				systemHash: currFp?.systemHash ?? null,
				toolsHash: currFp?.toolsHash ?? null,
				itemCount: currFp ? currFp.itemHashes.length : null,
			};
			this.pushRecord(record);
			return record;
		}

		const nextCallIndex = this.calls + 1;
		const hitPct = Math.round((cacheRead / totalPromptTokens) * 100);
		const sharpDrop = this.prevHitPct !== null && (this.prevHitPct - hitPct) >= SHARP_DROP_PP;

		let cause: CacheCause;
		let detail: string | null = null;
		let isAnomaly = false;

		if (totalPromptTokens < MIN_CACHEABLE_TOKENS) {
			cause = "below_min_tokens";
			detail = `${totalPromptTokens} tokens < ${MIN_CACHEABLE_TOKENS}`;
		} else if (!this.hasBaseline) {
			cause = "cold_start";
			detail = cacheWrite > 0 ? `wrote ${fmtCompactTokens(cacheWrite)}` : null;
		} else if (hitPct >= HEALTHY_HIT_PCT && !sharpDrop) {
			cause = "healthy";
		} else {
			// Evaluate concrete anomaly causes in priority order.
			const modelChangedByKey = Boolean(
				this.prevModelKey && effectiveModel && this.prevModelKey !== effectiveModel,
			);
			const modelChangedByPayload = Boolean(
				this.prevModelInPayload && currFp?.modelInPayload && this.prevModelInPayload !== currFp.modelInPayload,
			);
			const toolsMutated = Boolean(
				this.prevToolsHash !== null && currFp !== null && currFp.toolsHash !== this.prevToolsHash,
			);
			const systemMutated = Boolean(
				this.prevSystemHash !== null && currFp !== null && currFp.systemHash !== this.prevSystemHash,
			);
			const historyDivergence = this.prevItemHashes !== null && currFp !== null
				? findHistoryDivergence(this.prevItemHashes, currFp.itemHashes)
				: null;
			const elapsedSec = this.lastCacheTouchAtMs !== null
				? Math.max(0, (nowMs - this.lastCacheTouchAtMs) / 1000)
				: null;
			const ttlExpired = Boolean(
				elapsedSec !== null &&
				this.lastCacheTouchTtlSec !== null &&
				elapsedSec > this.lastCacheTouchTtlSec,
			);

			if (modelChangedByKey || modelChangedByPayload) {
				cause = "model_changed";
				isAnomaly = true;
				const prevLabel = modelChangedByKey ? this.prevModelKey : this.prevModelInPayload;
				const currLabel = modelChangedByKey ? effectiveModel : currFp?.modelInPayload;
				detail = `${prevLabel} -> ${currLabel}`;
			} else if (sawStrictFallback) {
				cause = "provider_strict_fallback";
				isAnomaly = true;
				detail = "strict tool grammar dropped on retry";
			} else if (toolsMutated && currFp && this.prevToolsHash) {
				cause = "tools_mutated";
				isAnomaly = true;
				detail = describeToolDiff(this.prevToolHashes, currFp.toolHashes, this.prevToolsHash, currFp.toolsHash);
			} else if (systemMutated && currFp && this.prevSystemHash) {
				cause = "system_mutated";
				isAnomaly = true;
				const delta = this.prevSystemBytes !== null ? currFp.systemBytes - this.prevSystemBytes : null;
				const deltaPart = delta !== null ? `${delta >= 0 ? "+" : ""}${delta} B, ` : "";
				if (this.prevSystemText !== null) {
					const { charIdx, byteIdx } = findFirstStringDiff(this.prevSystemText, currFp.systemText);
					detail = `char@${charIdx} byte@${byteIdx} (${deltaPart}${this.prevSystemHash}->${currFp.systemHash})`;
				} else {
					detail = `(${deltaPart}${this.prevSystemHash}->${currFp.systemHash})`;
				}
			} else if (historyDivergence !== null && currFp && this.prevItemHashes) {
				cause = "history_rewritten";
				isAnomaly = true;
				const compactedNote = this.compactedSinceLastCall ? ", compacted" : "";
				detail = `item #${historyDivergence} (${this.prevItemHashes.length}->${currFp.itemHashes.length}${compactedNote})`;
			} else if (ttlExpired && elapsedSec !== null && this.lastCacheTouchTtlSec !== null) {
				cause = "ttl_expired_likely";
				isAnomaly = true;
				detail = `elapsed ${Math.round(elapsedSec)}s > ${this.lastCacheTouchTtlSec}s`;
			} else if (hitPct >= WARMUP_MIN_HIT_PCT && hitPct < HEALTHY_HIT_PCT && !sharpDrop && nextCallIndex <= WARMUP_MAX_CALLS) {
				cause = "warmup";
				isAnomaly = false;
			} else {
				const prefixIntact = Boolean(
					currFp !== null &&
					this.prevSystemHash !== null &&
					currFp.systemHash === this.prevSystemHash &&
					this.prevToolsHash !== null &&
					currFp.toolsHash === this.prevToolsHash &&
					this.prevItemHashes !== null &&
					findHistoryDivergence(this.prevItemHashes, currFp.itemHashes) === null,
				);
				if (prefixIntact && cacheRead === 0 && currFp) {
					cause = "provider_miss_or_routing";
					isAnomaly = true;
					const keyChanged = this.prevPromptCacheKey !== null && currFp.promptCacheKey !== this.prevPromptCacheKey
						? `, prompt_cache_key changed`
						: "";
					detail = `prefix intact (sys:${currFp.systemHash} tools:${currFp.toolsHash}${keyChanged})`;
				} else {
					cause = "partial_hit";
					isAnomaly = true;
					detail = this.prevHitPct !== null ? `${this.prevHitPct}% -> ${hitPct}%` : `hit ${hitPct}%`;
				}
			}
		}

		const record: CacheCallRecord = {
			callIndex: nextCallIndex,
			atMs: nowMs,
			model: effectiveModel,
			api: currFp?.api ?? null,
			inputTokens,
			outputTokens,
			cacheRead,
			cacheWrite,
			totalPromptTokens,
			hitPct,
			cause,
			tag: CAUSE_TAGS[cause],
			isAnomaly,
			detail,
			systemHash: currFp?.systemHash ?? null,
			toolsHash: currFp?.toolsHash ?? null,
			itemCount: currFp ? currFp.itemHashes.length : null,
		};

		this.calls = nextCallIndex;
		this.sessionPromptTotal += totalPromptTokens;
		this.sessionCacheRead += cacheRead;
		this.sessionCacheWrite += cacheWrite;
		this.lastEvaluableRecord = record;
		this.pushRecord(record);
		if (isAnomaly) {
			this.anomalies.push(record);
			if (this.anomalies.length > MAX_ANOMALIES) this.anomalies.shift();
		}

		if (totalPromptTokens >= MIN_CACHEABLE_TOKENS) {
			this.hasBaseline = true;
			this.prevHitPct = hitPct;
		}
		if (effectiveModel !== null) {
			this.prevModelKey = effectiveModel;
		}
		if (currFp !== null) {
			this.prevModelInPayload = currFp.modelInPayload;
			this.prevSystemHash = currFp.systemHash;
			this.prevSystemText = currFp.systemText;
			this.prevSystemBytes = currFp.systemBytes;
			this.prevToolsHash = currFp.toolsHash;
			this.prevToolHashes = { ...currFp.toolHashes };
			this.prevItemHashes = [...currFp.itemHashes];
			this.prevPromptCacheKey = currFp.promptCacheKey;
		}
		const implicitCacheWrite = Boolean(
			totalPromptTokens >= MIN_CACHEABLE_TOKENS &&
			currFp !== null &&
			currFp.api !== "anthropic-messages" &&
			currFp.retentionTtlSec !== null,
		);
		if (cacheRead > 0 || cacheWrite > 0 || implicitCacheWrite) {
			this.lastCacheTouchAtMs = nowMs;
			if (currFp?.retentionTtlSec != null) {
				this.lastCacheTouchTtlSec = currFp.retentionTtlSec;
			}
		}
		this.compactedSinceLastCall = false;

		return record;
	}

	private pushRecord(record: CacheCallRecord): void {
		this.records.push(record);
		if (this.records.length > MAX_RECORDS) this.records.shift();
	}

	lastRecord(): CacheCallRecord | null {
		return this.lastEvaluableRecord;
	}

	getRecords(): readonly CacheCallRecord[] {
		return this.records;
	}

	getAnomalies(): readonly CacheCallRecord[] {
		return this.anomalies;
	}

	sessionStats(): { calls: number; promptTotal: number; cacheRead: number; cacheWrite: number; hitPct: number | null; anomalyCount: number } {
		const hitPct = this.sessionPromptTotal > 0
			? Math.round((this.sessionCacheRead / this.sessionPromptTotal) * 100)
			: null;
		return {
			calls: this.calls,
			promptTotal: this.sessionPromptTotal,
			cacheRead: this.sessionCacheRead,
			cacheWrite: this.sessionCacheWrite,
			hitPct,
			anomalyCount: this.anomalies.length,
		};
	}

	lastAnomalyBadge(): CacheAnomalyBadge | null {
		const last = this.lastEvaluableRecord;
		if (!last || !last.isAnomaly || !last.tag || last.hitPct === null) return null;
		return {
			hitPct: last.hitPct,
			tag: last.tag,
			severity: last.hitPct < 25 ? "error" : "warning",
		};
	}

	formatCacheReport(mode: "summary" | "anomalies"): string {
		if (mode === "anomalies") {
			if (this.anomalies.length === 0) {
				return "Cache lens: no cache anomalies recorded in this session.";
			}
			const stats = this.sessionStats();
			const lines = [
				`Prefix cache anomalies (${this.anomalies.length} of ${stats.calls} calls, session ${stats.hitPct ?? 0}% hit):`,
			];
			for (const rec of this.anomalies) {
				lines.push(formatRecordLine(rec));
			}
			return lines.join("\n");
		}

		if (this.calls === 0 && this.records.length === 0) {
			return "Cache lens: no LLM calls recorded in this session yet.";
		}

		const stats = this.sessionStats();
		const lines = [
			`Prefix cache: ${stats.hitPct ?? 0}% hit (${fmtCompactTokens(stats.cacheRead)}/${fmtCompactTokens(stats.promptTotal)} read, ${stats.calls} calls, ${stats.anomalyCount} anomalies)`,
		];
		const latest = this.lastEvaluableRecord;
		if (latest) {
			const tagPart = latest.tag ? ` ${latest.tag}` : "";
			const detailPart = latest.detail ? ` — ${latest.detail}` : "";
			lines.push(`Latest #${latest.callIndex}: ${latest.hitPct ?? 0}% (${latest.cause}${tagPart})${detailPart}`);
		}
		const recent = this.records.slice(-SUMMARY_RECENT_LIMIT);
		if (recent.length > 0) {
			lines.push(`Recent calls (last ${recent.length}):`);
			for (const rec of recent) {
				lines.push(formatRecordLine(rec));
			}
		}
		return lines.join("\n");
	}

	/**
	 * Exports reload-safe metadata ONLY. Never includes `prevSystemText` or any raw prompt body.
	 */
	toReloadSnapshot(): CacheLensReloadSnapshot {
		return {
			calls: this.calls,
			sessionPromptTotal: this.sessionPromptTotal,
			sessionCacheRead: this.sessionCacheRead,
			sessionCacheWrite: this.sessionCacheWrite,
			hasBaseline: this.hasBaseline,
			prevHitPct: this.prevHitPct,
			prevModelKey: this.prevModelKey,
			prevModelInPayload: this.prevModelInPayload,
			prevSystemHash: this.prevSystemHash,
			prevSystemBytes: this.prevSystemBytes,
			prevToolsHash: this.prevToolsHash,
			prevToolHashes: this.prevToolHashes ? { ...this.prevToolHashes } : null,
			prevItemHashes: this.prevItemHashes ? [...this.prevItemHashes] : null,
			prevPromptCacheKey: this.prevPromptCacheKey,
			lastCacheTouchAtMs: this.lastCacheTouchAtMs,
			lastCacheTouchTtlSec: this.lastCacheTouchTtlSec,
			lastRecord: this.lastEvaluableRecord ? { ...this.lastEvaluableRecord } : null,
			records: this.records.map(r => ({ ...r })),
			anomalies: this.anomalies.map(r => ({ ...r })),
		};
	}

	restoreReloadSnapshot(data: unknown): boolean {
		const parsed = parseCacheLensReloadSnapshot(data);
		if (!parsed) return false;
		this.calls = parsed.calls;
		this.sessionPromptTotal = parsed.sessionPromptTotal;
		this.sessionCacheRead = parsed.sessionCacheRead;
		this.sessionCacheWrite = parsed.sessionCacheWrite;
		this.hasBaseline = parsed.hasBaseline;
		this.prevHitPct = parsed.prevHitPct;
		this.prevModelKey = parsed.prevModelKey;
		this.prevModelInPayload = parsed.prevModelInPayload;
		this.prevSystemHash = parsed.prevSystemHash;
		this.prevSystemText = null; // Never persisted or restored.
		this.prevSystemBytes = parsed.prevSystemBytes;
		this.prevToolsHash = parsed.prevToolsHash;
		this.prevToolHashes = parsed.prevToolHashes ? { ...parsed.prevToolHashes } : null;
		this.prevItemHashes = parsed.prevItemHashes ? [...parsed.prevItemHashes] : null;
		this.prevPromptCacheKey = parsed.prevPromptCacheKey;
		this.lastCacheTouchAtMs = parsed.lastCacheTouchAtMs;
		this.lastCacheTouchTtlSec = parsed.lastCacheTouchTtlSec;
		this.lastEvaluableRecord = parsed.lastRecord ? { ...parsed.lastRecord } : null;
		this.records = parsed.records.map(r => ({ ...r }));
		this.anomalies = parsed.anomalies.map(r => ({ ...r }));
		this.pendingCaptures = [];
		this.compactedSinceLastCall = false;
		return true;
	}
}

function formatRecordLine(rec: CacheCallRecord): string {
	const model = shortModelName(rec.model);
	if (rec.cause === "usage_unavailable") {
		const detail = rec.detail ? ` — ${rec.detail}` : "";
		return `  #${rec.callIndex} ${model}  n/a  usage_unavailable${detail}`;
	}
	const pct = `${rec.hitPct ?? 0}%`.padStart(4);
	const tokens = `${fmtCompactTokens(rec.cacheRead)}/${fmtCompactTokens(rec.totalPromptTokens)}`;
	const sys = `sys:${rec.systemHash ?? "-"}`;
	const tools = `tools:${rec.toolsHash ?? "-"}`;
	const tag = rec.tag ? ` (${rec.tag})` : "";
	const detail = rec.detail ? ` — ${rec.detail}` : "";
	return `  #${rec.callIndex} ${model} ${pct}  ${tokens}  ${sys}  ${tools}  ${rec.cause}${tag}${detail}`;
}

function isNonNegFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableNonNegFinite(value: unknown): value is number | null {
	return value === null || isNonNegFinite(value);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	for (const v of Object.values(value)) {
		if (typeof v !== "string") return false;
	}
	return true;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(v => typeof v === "string");
}

function parseCacheCallRecord(data: unknown): CacheCallRecord | null {
	if (!isRecord(data)) return null;
	if (
		!isNonNegFinite(data.callIndex) ||
		!isNonNegFinite(data.atMs) ||
		!isNullableString(data.model) ||
		!(data.api === null || (typeof data.api === "string" && VALID_APIS.has(data.api))) ||
		!isNonNegFinite(data.inputTokens) ||
		!isNonNegFinite(data.outputTokens) ||
		!isNonNegFinite(data.cacheRead) ||
		!isNonNegFinite(data.cacheWrite) ||
		!isNonNegFinite(data.totalPromptTokens) ||
		!isNullableNonNegFinite(data.hitPct) ||
		typeof data.cause !== "string" || !VALID_CAUSES.has(data.cause) ||
		!isNullableString(data.tag) ||
		typeof data.isAnomaly !== "boolean" ||
		!isNullableString(data.detail) ||
		!isNullableString(data.systemHash) ||
		!isNullableString(data.toolsHash) ||
		!isNullableNonNegFinite(data.itemCount)
	) {
		return null;
	}
	return {
		callIndex: data.callIndex,
		atMs: data.atMs,
		model: data.model,
		api: data.api as WireApi | null,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheRead: data.cacheRead,
		cacheWrite: data.cacheWrite,
		totalPromptTokens: data.totalPromptTokens,
		hitPct: data.hitPct,
		cause: data.cause as CacheCause,
		tag: data.tag,
		isAnomaly: data.isAnomaly,
		detail: data.detail,
		systemHash: data.systemHash,
		toolsHash: data.toolsHash,
		itemCount: data.itemCount,
	};
}

export function parseCacheLensReloadSnapshot(data: unknown): CacheLensReloadSnapshot | null {
	if (!isRecord(data)) return null;
	if (
		!isNonNegFinite(data.calls) ||
		!isNonNegFinite(data.sessionPromptTotal) ||
		!isNonNegFinite(data.sessionCacheRead) ||
		!isNonNegFinite(data.sessionCacheWrite) ||
		typeof data.hasBaseline !== "boolean" ||
		!isNullableNonNegFinite(data.prevHitPct) ||
		!isNullableString(data.prevModelKey) ||
		!isNullableString(data.prevModelInPayload) ||
		!isNullableString(data.prevSystemHash) ||
		!isNullableNonNegFinite(data.prevSystemBytes) ||
		!isNullableString(data.prevToolsHash) ||
		!(data.prevToolHashes === null || isStringRecord(data.prevToolHashes)) ||
		!(data.prevItemHashes === null || isStringArray(data.prevItemHashes)) ||
		!isNullableString(data.prevPromptCacheKey) ||
		!isNullableNonNegFinite(data.lastCacheTouchAtMs) ||
		!isNullableNonNegFinite(data.lastCacheTouchTtlSec) ||
		!Array.isArray(data.records) ||
		!Array.isArray(data.anomalies)
	) {
		return null;
	}

	let lastRecord: CacheCallRecord | null = null;
	if (data.lastRecord !== null) {
		lastRecord = parseCacheCallRecord(data.lastRecord);
		if (!lastRecord) return null;
	}

	const records: CacheCallRecord[] = [];
	for (const item of data.records.slice(-MAX_RECORDS)) {
		const parsed = parseCacheCallRecord(item);
		if (!parsed) return null;
		records.push(parsed);
	}

	const anomalies: CacheCallRecord[] = [];
	for (const item of data.anomalies.slice(-MAX_ANOMALIES)) {
		const parsed = parseCacheCallRecord(item);
		if (!parsed) return null;
		anomalies.push(parsed);
	}

	return {
		calls: data.calls,
		sessionPromptTotal: data.sessionPromptTotal,
		sessionCacheRead: data.sessionCacheRead,
		sessionCacheWrite: data.sessionCacheWrite,
		hasBaseline: data.hasBaseline,
		prevHitPct: data.prevHitPct,
		prevModelKey: data.prevModelKey,
		prevModelInPayload: data.prevModelInPayload,
		prevSystemHash: data.prevSystemHash,
		prevSystemBytes: data.prevSystemBytes,
		prevToolsHash: data.prevToolsHash,
		prevToolHashes: data.prevToolHashes ? { ...data.prevToolHashes } : null,
		prevItemHashes: data.prevItemHashes ? [...data.prevItemHashes] : null,
		prevPromptCacheKey: data.prevPromptCacheKey,
		lastCacheTouchAtMs: data.lastCacheTouchAtMs,
		lastCacheTouchTtlSec: data.lastCacheTouchTtlSec,
		lastRecord,
		records,
		anomalies,
	};
}
