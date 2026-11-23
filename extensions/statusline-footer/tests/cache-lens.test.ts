import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CacheLensTracker,
	fingerprintProviderPayload,
	parseCacheLensReloadSnapshot,
	sha256StableShort,
	updateHashCanonical,
	type AssistantMessageLike,
} from "../cache-lens.ts";

function assistantMsg(
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
	overrides: Partial<AssistantMessageLike> = {},
): AssistantMessageLike {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop",
		usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, ...usage },
		...overrides,
	};
}

describe("fingerprintProviderPayload", () => {
	it("fingerprints anthropic-messages, strips wire cache_control without touching schemas or tool inputs, and canonicalizes single-text wrappers", () => {
		const payloadA = {
			model: "claude-sonnet-4",
			system: [{ type: "text", text: "You are Pi.", cache_control: { type: "ephemeral", ttl: "1h" } }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					cache_control: { type: "ephemeral" },
					input_schema: {
						type: "object",
						properties: {
							path: { type: "string" },
							cache_control: { type: "string", description: "User schema property named cache_control" },
						},
					},
				},
			],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
				},
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tu_1",
							name: "read",
							input: { path: "a.ts", cache_control: "keep-inside-input" },
							cache_control: { type: "ephemeral" },
						},
					],
				},
				{
					role: "user",
					cache_control: { type: "ephemeral" },
					content: [
						{
							type: "tool_result",
							tool_use_id: "tu_1",
							content: [{ type: "text", text: "file contents", cache_control: { type: "ephemeral" } }],
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};

		const payloadB = {
			model: "claude-sonnet-4",
			system: "You are Pi.",
			tools: [
				{
					name: "read",
					description: "Read a file",
					input_schema: {
						type: "object",
						properties: {
							cache_control: { description: "User schema property named cache_control", type: "string" },
							path: { type: "string" },
						},
					},
				},
			],
			messages: [
				{ role: "user", content: "Hello" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tu_1",
							name: "read",
							input: { cache_control: "keep-inside-input", path: "a.ts" },
						},
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }],
				},
			],
		};

		const snapshotBefore = JSON.stringify(payloadA);
		const fpA = fingerprintProviderPayload(payloadA);
		const fpB = fingerprintProviderPayload(payloadB, "anthropic-messages");

		// Never mutates the outgoing payload.
		expect(JSON.stringify(payloadA)).toBe(snapshotBefore);

		expect(fpA.api).toBe("anthropic-messages");
		expect(fpB.api).toBe("anthropic-messages");
		expect(fpA.systemHash).toBe(fpB.systemHash);
		expect(fpA.systemText).toBe("You are Pi.");
		expect(fpA.toolsHash).toBe(fpB.toolsHash);
		expect(fpA.itemHashes).toEqual(fpB.itemHashes);
		expect(fpA.fullRequestHash).toBe(fpB.fullRequestHash);
		expect(fpA.retentionTtlSec).toBe(3600);
		expect(fpA.retentionActive).toBe(true);
		expect(fpB.retentionTtlSec).toBeNull();
		expect(fpB.retentionActive).toBe(false);

		// Mutating cache_control INSIDE input_schema or tool_use.input MUST change hashes.
		const mutatedSchema = structuredClone(payloadB);
		mutatedSchema.tools[0]!.input_schema.properties.cache_control.description = "Changed";
		expect(fingerprintProviderPayload(mutatedSchema, "anthropic-messages").toolsHash).not.toBe(fpB.toolsHash);

		const mutatedInput = structuredClone(payloadB);
		(mutatedInput.messages[1]!.content as any)[0].input.cache_control = "mutated";
		expect(fingerprintProviderPayload(mutatedInput, "anthropic-messages").itemHashes[1]).not.toBe(fpB.itemHashes[1]);
	});

	it("fingerprints openai-responses payloads with instructions, input[], strict tools, and retention options", () => {
		const payload = {
			model: "gpt-5.4",
			instructions: "Be concise.",
			prompt_cache_key: "sess-abc",
			prompt_cache_retention: "24h",
			reasoning: { effort: "high" },
			tools: [
				{
					type: "function",
					name: "bash",
					description: "Run shell command",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							command: { type: "string" },
							cache_control: { type: "boolean" },
						},
					},
				},
			],
			input: [
				{ role: "user", content: [{ type: "input_text", text: "ls" }] },
				{ type: "function_call", name: "bash", arguments: '{"command":"ls","cache_control":true}' },
			],
		};

		const fp = fingerprintProviderPayload(payload);
		expect(fp.api).toBe("openai-responses");
		expect(fp.modelInPayload).toBe("gpt-5.4");
		expect(fp.promptCacheKey).toBe("sess-abc");
		expect(fp.effort).toBe("high");
		expect(fp.systemText).toBe("Be concise.");
		expect(fp.systemBytes).toBe(11);
		expect(fp.itemHashes).toHaveLength(2);
		expect(fp.hasStrictTools).toBe(true);
		expect(fp.toolHashes.bash).toHaveLength(12);
		expect(fp.retentionTtlSec).toBe(86400);
		expect(fp.retentionActive).toBe(true);

		// Dropping strict changes toolsHash but keeps nonStrictToolsHash identical.
		const relaxed = structuredClone(payload);
		delete (relaxed.tools[0] as { strict?: boolean }).strict;
		const fpRelaxed = fingerprintProviderPayload(relaxed, "openai-responses");
		expect(fpRelaxed.hasStrictTools).toBe(false);
		expect(fpRelaxed.toolsHash).not.toBe(fp.toolsHash);
		expect(fpRelaxed.nonStrictToolsHash).toBe(fp.nonStrictToolsHash);
	});

	it("fingerprints openai-completions payloads, separates leading system/developer messages, and strips wire cache_control only", () => {
		const payloadA = {
			model: "kimi-k2.5",
			reasoning_effort: "medium",
			prompt_cache_options: { ttl: "30m" },
			tools: [
				{
					type: "function",
					cache_control: { type: "ephemeral" },
					function: {
						name: "grep",
						strict: true,
						cache_control: { type: "ephemeral" },
						parameters: { type: "object", properties: { cache_control: { type: "string" } } },
					},
				},
			],
			messages: [
				{ role: "system", content: [{ type: "text", text: "System prompt", cache_control: { type: "ephemeral" } }] },
				{ role: "user", content: [{ type: "text", text: "Search foo", cache_control: { type: "ephemeral" } }] },
				{
					role: "assistant",
					tool_calls: [{ id: "tc1", type: "function", function: { name: "grep", arguments: '{"cache_control":"keep"}' } }],
				},
			],
		};
		const payloadB = {
			model: "kimi-k2.5",
			reasoning_effort: "medium",
			tools: [
				{
					type: "function",
					function: {
						name: "grep",
						strict: true,
						parameters: { type: "object", properties: { cache_control: { type: "string" } } },
					},
				},
			],
			messages: [
				{ role: "system", content: "System prompt" },
				{ role: "user", content: "Search foo" },
				{
					role: "assistant",
					tool_calls: [{ id: "tc1", type: "function", function: { name: "grep", arguments: '{"cache_control":"keep"}' } }],
				},
			],
		};

		const fpA = fingerprintProviderPayload(payloadA);
		const fpB = fingerprintProviderPayload(payloadB, "openai-completions");
		expect(fpA.api).toBe("openai-completions");
		expect(fpA.systemText).toBe("System prompt");
		expect(fpA.systemHash).toBe(fpB.systemHash);
		expect(fpA.toolsHash).toBe(fpB.toolsHash);
		expect(fpA.itemHashes).toHaveLength(2); // excludes leading system message
		expect(fpA.itemHashes).toEqual(fpB.itemHashes);
		expect(fpA.hasStrictTools).toBe(true);
		expect(fpA.effort).toBe("medium");
		expect(fpA.retentionTtlSec).toBe(1800);
		expect(fpA.retentionActive).toBe(true);
	});

	it("detects all retention TTL variants cleanly", () => {
		expect(fingerprintProviderPayload({ system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "5m" } }] }).retentionTtlSec).toBe(290);
		expect(fingerprintProviderPayload({ system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] }).retentionTtlSec).toBe(3600);
		expect(fingerprintProviderPayload({ system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }).retentionTtlSec).toBe(290);
		expect(fingerprintProviderPayload({ input: [], prompt_cache_key: "k1" }).retentionTtlSec).toBe(290);
		expect(fingerprintProviderPayload({ input: [], prompt_cache_retention: "in-memory" }).retentionTtlSec).toBe(290);
		expect(fingerprintProviderPayload({ input: [], prompt_cache_retention: "in_memory" }).retentionTtlSec).toBe(290);
		expect(fingerprintProviderPayload({ input: [], prompt_cache_retention: "24h" }).retentionTtlSec).toBe(86400);
		expect(fingerprintProviderPayload({ messages: [], prompt_cache_options: { ttl: "1h" } }).retentionTtlSec).toBe(3600);
		expect(fingerprintProviderPayload({ messages: [], prompt_cache_options: { ttl: "24h" } }).retentionTtlSec).toBe(86400);
		expect(fingerprintProviderPayload({ messages: [{ role: "user", content: "hi" }] }).retentionActive).toBe(false);
	});
});

describe("CacheLensTracker root-cause classification", () => {
	interface AnthropicPayload {
		model: string;
		system: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
		tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
		messages: Array<{ role: string; content: string }>;
	}

	const basePayload = (): AnthropicPayload => ({
		model: "claude-sonnet-4",
		system: [{ type: "text", text: "You are a helpful coding assistant.", cache_control: { type: "ephemeral", ttl: "5m" } }],
		tools: [
			{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
			{ name: "bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
		],
		messages: [{ role: "user", content: "Explain this module." }],
	});

	it("classifies below_min_tokens, cold_start, warmup, and healthy as non-anomalies", () => {
		const tracker = new CacheLensTracker();

		// Below min cacheable tokens (<1024)
		tracker.recordRequest(basePayload(), { api: "anthropic-messages", nowMs: 1_000 });
		const tiny = tracker.recordMessageEnd(assistantMsg({ input: 512, cacheRead: 0, cacheWrite: 0 }), 1_500);
		expect(tiny?.cause).toBe("below_min_tokens");
		expect(tiny?.tag).toBe("(<1k)");
		expect(tiny?.isAnomaly).toBe(false);
		expect(tracker.lastAnomalyBadge()).toBeNull();

		// First >=1024 token call is cold_start (since previous call was <1k)
		tracker.recordRequest(basePayload(), { api: "anthropic-messages", nowMs: 2_000 });
		const cold = tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 2_500);
		expect(cold?.cause).toBe("cold_start");
		expect(cold?.tag).toBe("(cold)");
		expect(cold?.isAnomaly).toBe(false);
		expect(tracker.lastAnomalyBadge()).toBeNull();

		// Warmup call (calls <= 3, hitPct 50..69%, no sharp drop, no wire mutation) -> non-anomaly
		const p2 = basePayload();
		p2.messages.push({ role: "assistant", content: "Sure." }, { role: "user", content: "Next?" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 3_000 });
		const warm = tracker.recordMessageEnd(assistantMsg({ input: 400, cacheRead: 6000, cacheWrite: 3600 }), 3_500);
		expect(warm?.hitPct).toBe(60);
		expect(warm?.cause).toBe("warmup");
		expect(warm?.isAnomaly).toBe(false);
		expect(tracker.lastAnomalyBadge()).toBeNull();

		// Healthy call (>= 70%)
		const p3 = structuredClone(p2);
		p3.messages.push({ role: "assistant", content: "Done." }, { role: "user", content: "More?" });
		tracker.recordRequest(p3, { api: "anthropic-messages", nowMs: 4_000 });
		const healthy = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 9800, cacheWrite: 0 }), 4_500);
		expect(healthy?.cause).toBe("healthy");
		expect(healthy?.tag).toBeNull();
		expect(healthy?.isAnomaly).toBe(false);
		expect(tracker.lastAnomalyBadge()).toBeNull();
	});

	it("classifies system_mutated with exact char@/byte@ offsets, UTF-8 byte delta, and hash transition", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		p1.system = [{ type: "text", text: "Prefix 世界 alpha", cache_control: { type: "ephemeral" } }];
		const fp1 = tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 4000 }), 1_200);

		const p2 = structuredClone(p1);
		p2.system = [{ type: "text", text: "Prefix 世界 beta!!", cache_control: { type: "ephemeral" } }];
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "go" });
		const fp2 = tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 2_000 });
		const rec = tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 4200 }), 2_200);

		expect(rec?.cause).toBe("system_mutated");
		expect(rec?.tag).toBe("!sys");
		expect(rec?.isAnomaly).toBe(true);
		// "Prefix 世界 " is 10 UTF-16 code units, 7 + 6 + 1 = 14 UTF-8 bytes; "beta!!" vs "alpha" is +1 byte.
		expect(rec?.detail).toBe(`char@10 byte@14 (+1 B, ${fp1.systemHash}->${fp2.systemHash})`);
		expect(tracker.lastAnomalyBadge()).toEqual({ hitPct: 0, tag: "!sys", severity: "error" });
	});

	it("classifies tools_mutated with +added, -removed, ~modified tool names", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		const fp1 = tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 4000 }), 1_200);

		const p2 = structuredClone(p1);
		p2.tools = [
			{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } },
			{ name: "write", input_schema: { type: "object", properties: { content: { type: "string" } } } },
		];
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "go" });
		const fp2 = tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 2_000 });
		const rec = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 1000, cacheWrite: 3000 }), 2_200);

		expect(rec?.cause).toBe("tools_mutated");
		expect(rec?.tag).toBe("!tools");
		expect(rec?.isAnomaly).toBe(true);
		expect(rec?.detail).toBe(`+write, -bash, ~read (${fp1.toolsHash}->${fp2.toolsHash})`);
		expect(tracker.lastAnomalyBadge()).toEqual({ hitPct: 24, tag: "!tools", severity: "error" });
	});

	it("classifies provider_strict_fallback when a same-turn retry drops strict: true", () => {
		const tracker = new CacheLensTracker();
		const strictPayload = {
			model: "gpt-5.4",
			instructions: "System",
			prompt_cache_key: "k1",
			tools: [{ type: "function", name: "read", strict: true, parameters: { type: "object" } }],
			input: [{ role: "user", content: "hi" }],
		};
		tracker.recordRequest(strictPayload, { api: "openai-responses", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 4000, cacheRead: 0 }, { provider: "openai", model: "gpt-5.4" }), 1_500);

		const turn2Strict = structuredClone(strictPayload);
		turn2Strict.input.push({ role: "assistant", content: "hello" }, { role: "user", content: "next" });
		const turn2Relaxed = structuredClone(turn2Strict);
		delete (turn2Relaxed.tools[0] as { strict?: boolean }).strict;

		tracker.recordRequest(turn2Strict, { api: "openai-responses", nowMs: 2_000 });
		tracker.recordRequest(turn2Relaxed, { api: "openai-responses", nowMs: 2_100 });
		const rec = tracker.recordMessageEnd(
			assistantMsg({ input: 3500, cacheRead: 1000 }, { provider: "openai", model: "gpt-5.4" }),
			2_500,
		);

		expect(rec?.cause).toBe("provider_strict_fallback");
		expect(rec?.tag).toBe("!strict");
		expect(rec?.isAnomaly).toBe(true);
		expect(rec?.detail).toContain("strict");
	});

	it("classifies history_rewritten with exact item #idx and compaction note", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		p1.messages = [
			{ role: "user", content: "m0" },
			{ role: "assistant", content: "m1" },
			{ role: "user", content: "m2" },
			{ role: "assistant", content: "m3" },
		];
		tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_200);

		// Mid-history edit at item #2 without compaction
		const p2 = structuredClone(p1);
		p2.messages[2] = { role: "user", content: "m2-edited" };
		p2.messages.push({ role: "user", content: "m4" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 2_000 });
		const edited = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 2000, cacheWrite: 3000 }), 2_200);
		expect(edited?.cause).toBe("history_rewritten");
		expect(edited?.tag).toBe("!hist");
		expect(edited?.detail).toBe("item #2 (4->5)");
		expect(tracker.lastAnomalyBadge()).toEqual({ hitPct: 38, tag: "!hist", severity: "warning" });

		// Compaction shrinks messages from 5 -> 2 and replaces item #0
		tracker.recordCompaction();
		const p3 = structuredClone(p2);
		p3.messages = [
			{ role: "user", content: "Compaction summary" },
			{ role: "user", content: "Continue" },
		];
		tracker.recordRequest(p3, { api: "anthropic-messages", nowMs: 3_000 });
		const compacted = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 1000, cacheWrite: 3000 }), 3_200);
		expect(compacted?.cause).toBe("history_rewritten");
		expect(compacted?.detail).toBe("item #0 (5->2, compacted)");
	});

	it("classifies ttl_expired_likely when elapsed time exceeds verified retentionTtlSec", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_000);

		const p2 = structuredClone(p1);
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "back after 412s" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 413_000 });
		const rec = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 0, cacheWrite: 5200 }), 413_000);

		expect(rec?.cause).toBe("ttl_expired_likely");
		expect(rec?.tag).toBe("!ttl");
		expect(rec?.isAnomaly).toBe(true);
		expect(rec?.detail).toBe("elapsed 412s > 290s");
	});

	it("classifies ttl_expired_likely after OpenAI Responses cold start without reported cacheWrite", () => {
		const tracker = new CacheLensTracker();
		const p1 = {
			model: "gpt-6-astra",
			instructions: "System prompt",
			prompt_cache_key: "sess-1",
			input: [{ role: "user", content: "hi" }],
		};
		tracker.recordRequest(p1, { api: "openai-responses", modelKey: "magpie/gpt-6-astra", nowMs: 1_000 });
		const cold = tracker.recordMessageEnd(
			assistantMsg({ input: 5000, cacheRead: 0, cacheWrite: 0 }, { provider: "magpie", model: "gpt-6-astra" }),
			1_000,
		);
		expect(cold?.cause).toBe("cold_start");

		const p2 = {
			...p1,
			input: [...p1.input, { role: "assistant", content: "ok" }, { role: "user", content: "back later" }],
		};
		tracker.recordRequest(p2, { api: "openai-responses", modelKey: "magpie/gpt-6-astra", nowMs: 401_000 });
		const expired = tracker.recordMessageEnd(
			assistantMsg({ input: 5200, cacheRead: 0, cacheWrite: 0 }, { provider: "magpie", model: "gpt-6-astra" }),
			401_000,
		);
		expect(expired?.cause).toBe("ttl_expired_likely");
		expect(expired?.tag).toBe("!ttl");
		expect(expired?.detail).toBe("elapsed 400s > 290s");
	});

	it("classifies model_changed when effective model changes", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		tracker.recordRequest(p1, { api: "anthropic-messages", modelKey: "anthropic/claude-sonnet-4", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_100);

		const p2 = structuredClone(p1);
		p2.model = "claude-opus-4";
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "switch" });
		tracker.recordRequest(p2, { api: "anthropic-messages", modelKey: "anthropic/claude-opus-4", nowMs: 2_000 });
		const rec = tracker.recordMessageEnd(
			assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5100 }, { model: "claude-opus-4" }),
			2_100,
		);

		expect(rec?.cause).toBe("model_changed");
		expect(rec?.tag).toBe("!model");
		expect(rec?.detail).toBe("anthropic/claude-sonnet-4 -> anthropic/claude-opus-4");
	});

	it("classifies provider_miss_or_routing when prefix is intact, within TTL, and cacheRead === 0", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_100);

		const p2 = structuredClone(p1);
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "next" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 10_000 });
		const rec = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 0, cacheWrite: 5200 }), 10_100);

		expect(rec?.cause).toBe("provider_miss_or_routing");
		expect(rec?.tag).toBe("!route");
		expect(rec?.isAnomaly).toBe(true);
		expect(rec?.detail).toContain("prefix intact");
	});

	it("classifies partial_hit on a sharp >=35pp drop without wire mutation or TTL expiry", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_100);

		const p2 = structuredClone(p1);
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "turn 2" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 2_000 });
		const r2 = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 9300, cacheWrite: 500 }), 2_100);
		expect(r2?.cause).toBe("healthy");
		expect(r2?.hitPct).toBe(93);

		const p3 = structuredClone(p2);
		p3.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "turn 3" });
		tracker.recordRequest(p3, { api: "anthropic-messages", nowMs: 3_000 });
		// 93% -> 55% is a 38pp sharp drop with intact prefix and non-zero cacheRead
		const r3 = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 5500, cacheWrite: 4300 }), 3_100);
		expect(r3?.cause).toBe("partial_hit");
		expect(r3?.tag).toBe("!drop");
		expect(r3?.isAnomaly).toBe(true);
		expect(r3?.detail).toBe("93% -> 55%");
		expect(tracker.lastAnomalyBadge()).toEqual({ hitPct: 55, tag: "!drop", severity: "warning" });
	});

	it("excludes error/aborted calls with zero prompt tokens as usage_unavailable without mutating stats or baseline", () => {
		const tracker = new CacheLensTracker();
		const p1 = basePayload();
		tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_100);

		// Aborted call with zero prompt tokens and a mutated system prompt (should NOT pollute baseline!)
		const abortedPayload = structuredClone(p1);
		abortedPayload.system = [{ type: "text", text: "TEMP ABORTED PROMPT" }];
		tracker.recordRequest(abortedPayload, { api: "anthropic-messages", nowMs: 2_000 });
		const aborted = tracker.recordMessageEnd(
			assistantMsg({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { stopReason: "aborted" }),
			2_100,
		);
		expect(aborted?.cause).toBe("usage_unavailable");
		expect(aborted?.isAnomaly).toBe(false);
		expect(aborted?.hitPct).toBeNull();
		expect(tracker.sessionStats().calls).toBe(1);
		expect(tracker.lastAnomalyBadge()).toBeNull();

		// Error call with zero prompt tokens
		tracker.recordRequest(abortedPayload, { api: "anthropic-messages", nowMs: 2_500 });
		const errored = tracker.recordMessageEnd(
			assistantMsg({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { stopReason: "error" }),
			2_600,
		);
		expect(errored?.cause).toBe("usage_unavailable");
		expect(tracker.sessionStats().calls).toBe(1);

		// Next normal call matches p1 baseline -> healthy
		const p2 = structuredClone(p1);
		p2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "next" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 3_000 });
		const next = tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 4800, cacheWrite: 0 }), 3_100);
		expect(next?.cause).toBe("healthy");
		expect(tracker.sessionStats().calls).toBe(2);
	});
});

describe("CacheLensTracker reload snapshots & formatting", () => {
	it("round-trips reload snapshot without serializing raw system prompt text", () => {
		const secretPrompt = "TOP_SECRET_SYSTEM_PROMPT_NEVER_SERIALIZE_ME_42";
		const tracker = new CacheLensTracker();
		const p1 = {
			model: "claude-sonnet-4",
			system: [{ type: "text", text: secretPrompt, cache_control: { type: "ephemeral" } }],
			tools: [{ name: "read", input_schema: { type: "object" } }],
			messages: [{ role: "user", content: "hello" }],
		};
		const fp1 = tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_100);

		const p2 = structuredClone(p1);
		p2.system = [{ type: "text", text: `${secretPrompt} EXTRA`, cache_control: { type: "ephemeral" } }];
		p2.messages.push({ role: "assistant", content: "hi" }, { role: "user", content: "next" });
		const fp2 = tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 2_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 0, cacheWrite: 5200 }), 2_100);

		const snapshot = tracker.toReloadSnapshot();
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain(secretPrompt);
		expect(serialized).not.toContain("EXTRA");
		expect(serialized).not.toContain("prevSystemText");

		const restored = new CacheLensTracker();
		expect(restored.restoreReloadSnapshot(JSON.parse(serialized))).toBe(true);
		expect(restored.sessionStats()).toEqual(tracker.sessionStats());
		expect(restored.lastAnomalyBadge()).toEqual({ hitPct: 0, tag: "!sys", severity: "error" });
		expect(restored.formatCacheReport("summary")).toContain(fp2.systemHash);
		expect(restored.formatCacheReport("anomalies")).toContain(`${fp1.systemHash}->${fp2.systemHash}`);

		// Post-reload system mutation still classifies cleanly even without prevSystemText in memory.
		const p3 = structuredClone(p2);
		p3.system = [{ type: "text", text: "COMPLETELY_DIFFERENT", cache_control: { type: "ephemeral" } }];
		p3.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "third" });
		const fp3 = restored.recordRequest(p3, { api: "anthropic-messages", nowMs: 3_000 });
		const rec3 = restored.recordMessageEnd(assistantMsg({ input: 200, cacheRead: 0, cacheWrite: 5300 }), 3_100);
		expect(rec3?.cause).toBe("system_mutated");
		expect(rec3?.detail).toContain(`${fp2.systemHash}->${fp3.systemHash}`);
		expect(rec3?.detail).not.toContain("char@");
	});

	it("rejects malformed reload snapshots cleanly", () => {
		expect(parseCacheLensReloadSnapshot(null)).toBeNull();
		expect(parseCacheLensReloadSnapshot({})).toBeNull();
		expect(parseCacheLensReloadSnapshot({ calls: -1 })).toBeNull();
		const valid = new CacheLensTracker().toReloadSnapshot();
		expect(parseCacheLensReloadSnapshot({ ...valid, records: [{ bad: true }] })).toBeNull();
		expect(parseCacheLensReloadSnapshot({ ...valid, prevToolHashes: { a: 123 } })).toBeNull();
	});

	it("formats summary and anomalies reports and clears state on reset()", () => {
		const tracker = new CacheLensTracker();
		expect(tracker.formatCacheReport("summary")).toContain("no LLM calls recorded");
		expect(tracker.formatCacheReport("anomalies")).toContain("no cache anomalies recorded");

		const p1 = {
			model: "claude-sonnet-4",
			system: "Sys A",
			tools: [{ name: "read", input_schema: { type: "object" } }],
			messages: [{ role: "user", content: "one" }],
		};
		tracker.recordRequest(p1, { api: "anthropic-messages", nowMs: 1_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 0, cacheWrite: 5000 }), 1_100);

		const p2 = structuredClone(p1);
		p2.messages.push({ role: "assistant", content: "a1" }, { role: "user", content: "two" });
		tracker.recordRequest(p2, { api: "anthropic-messages", nowMs: 2_000 });
		tracker.recordMessageEnd(assistantMsg({ input: 100, cacheRead: 4900, cacheWrite: 0 }), 2_100);

		expect(tracker.formatCacheReport("anomalies")).toContain("no cache anomalies recorded");
		const summary = tracker.formatCacheReport("summary");
		expect(summary).toContain("Prefix cache:");
		expect(summary).toContain("claude-sonnet-4");
		expect(summary).toContain("sys:");
		expect(summary).toContain("tools:");

		tracker.reset();
		expect(tracker.sessionStats().calls).toBe(0);
		expect(tracker.lastAnomalyBadge()).toBeNull();
		expect(tracker.formatCacheReport("summary")).toContain("no LLM calls recorded");
	});
});

/** Reference sorted-JSON serializer matching the original `stableStringify` contract. */
function referenceStableStringify(value: unknown, seen = new WeakSet<object>()): string {
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
				parts.push(item === undefined ? "null" : referenceStableStringify(item, seen));
			}
			return `[${parts.join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		const entries: string[] = [];
		for (const key of keys) {
			const prop = record[key];
			if (prop === undefined) continue;
			entries.push(`${JSON.stringify(key)}:${referenceStableStringify(prop, seen)}`);
		}
		return `{${entries.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

function referenceSha256Hex(value: unknown): string {
	return createHash("sha256").update(referenceStableStringify(value), "utf8").digest("hex");
}

function streamSha256Hex(value: unknown): string {
	const hash = createHash("sha256");
	updateHashCanonical(hash, value);
	return hash.digest("hex");
}

describe("streaming canonical SHA-256 parity", () => {
	it("matches reference sorted-JSON SHA-256 byte-for-byte across JS and JSON edge cases", () => {
		const sparse = new Array<unknown>(5);
		sparse[1] = "middle";
		sparse[3] = 0;

		const nullProto = Object.assign(Object.create(null), { z: 1, a: "ok", skip: undefined });

		const shared = { beta: [1, 2], alpha: "dag" };
		const dag = { second: shared, first: shared };

		const circularObj: Record<string, unknown> = { a: 1 };
		circularObj.self = circularObj;

		const circularArr: unknown[] = [1];
		circularArr.push(circularArr);

		const symKey = Symbol("ignored-key");
		const withSymbolsAndFunctions: Record<PropertyKey, unknown> = {
			a: undefined,
			b: () => "fn",
			c: Symbol("val"),
			d: undefined,
			e: 42,
			[symKey]: "not-enumerated",
		};

		const cases: unknown[] = [
			null,
			undefined,
			true,
			false,
			0,
			-0,
			42,
			-3.141592653589793,
			Number.MAX_SAFE_INTEGER,
			Number.MIN_VALUE,
			1e25,
			1e-10,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"",
			"plain ascii",
			() => 123,
			Symbol("top"),
			{},
			[],
			{ a: undefined, b: undefined },
			{ onlyUndefinedFirst: undefined, kept: 1, onlyUndefinedLast: undefined },
			[undefined, () => {}, Symbol("elem"), null, true, false, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
			sparse,
			nullProto,
			dag,
			circularObj,
			circularArr,
			withSymbolsAndFunctions,
			new Date(0),
			{ b: 2, toJSON: () => "custom", a: 1 },
		];

		for (const sample of cases) {
			const expectedHex = referenceSha256Hex(sample);
			expect(streamSha256Hex(sample)).toBe(expectedHex);
			expect(sha256StableShort(sample)).toBe(expectedHex.slice(0, 12));
		}
	});

	it("matches reference hash across key permutations and unicode/escape strings", () => {
		const nestedA = {
			z: {
				'key"quote': 'line1\nline2\r\t\b\f\\/"quoted"',
				"ctrl\u0000\u001f": "\u0000\u0007\u001f",
				"emoji-🚀": "family 👨‍👩‍👧‍👦 + 中文 + 日本語 + 한국어",
				"surrogates": "hi \ud800 mid \udfff end",
				dropMe: undefined,
			},
			a: [
				{ y: 2, x: 1, u: undefined },
				{ "b\\c": "val", "a\nb": [true, false, null, -0] },
			],
		};

		const nestedB = {
			a: [
				{ u: undefined, x: 1, y: 2 },
				{ "a\nb": [true, false, null, 0], "b\\c": "val" },
			],
			z: {
				"surrogates": "hi \ud800 mid \udfff end",
				"emoji-🚀": "family 👨‍👩‍👧‍👦 + 中文 + 日本語 + 한국어",
				dropMe: undefined,
				"ctrl\u0000\u001f": "\u0000\u0007\u001f",
				'key"quote': 'line1\nline2\r\t\b\f\\/"quoted"',
			},
		};

		const expectedHex = referenceSha256Hex(nestedA);
		expect(streamSha256Hex(nestedA)).toBe(expectedHex);
		expect(streamSha256Hex(nestedB)).toBe(expectedHex);
		expect(sha256StableShort(nestedA)).toBe(sha256StableShort(nestedB));
		expect(sha256StableShort(nestedA)).toBe(expectedHex.slice(0, 12));
	});

	it("matches reference hash on large arrays and nested conversation payloads", () => {
		const largeArray = Array.from({ length: 4000 }, (_, i) => ({
			idx: i,
			role: i % 2 === 0 ? "user" : "assistant",
			meta: i % 10 === 0 ? undefined : { tags: ["t1", `item-${i}`, i % 3 === 0 ? null : i], ok: i % 2 === 0 },
			text: `chunk ${i}: "quoted"\n\\path\\file_${i}.ts — café 🚀`,
		}));

		const expectedHex = referenceSha256Hex(largeArray);
		expect(streamSha256Hex(largeArray)).toBe(expectedHex);
		expect(sha256StableShort(largeArray)).toBe(expectedHex.slice(0, 12));

		const payload = {
			model: "claude-sonnet-4",
			system: [
				{ type: "text", text: "Block 1" },
				{ type: "text", text: "Block 2 🚀", cache_control: { type: "ephemeral" } },
			],
			tools: [
				{
					name: "search",
					strict: true,
					description: "Search files",
					input_schema: {
						type: "object",
						properties: {
							query: { type: "string" },
							limit: { type: "number" },
						},
					},
				},
			],
			messages: [
				{ role: "user", content: 'find "foo\\bar"\n🚀' },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tu_1", name: "search", input: { limit: 10, query: "foo" } }],
				},
			],
		};

		const fp = fingerprintProviderPayload(payload, "anthropic-messages");
		expect(fp.systemHash).toBe(referenceSha256Hex([{ type: "text", text: "Block 1" }, { type: "text", text: "Block 2 🚀" }]).slice(0, 12));
		expect(fp.toolsHash).toBe(referenceSha256Hex(payload.tools).slice(0, 12));
		expect(fp.toolHashes.search).toBe(referenceSha256Hex(payload.tools[0]).slice(0, 12));
		expect(fp.itemHashes).toEqual(payload.messages.map(m => referenceSha256Hex(m).slice(0, 12)));
		expect(fp.fullRequestHash).toBe(
			referenceSha256Hex({
				api: fp.api,
				modelInPayload: fp.modelInPayload,
				promptCacheKey: fp.promptCacheKey,
				effort: fp.effort,
				systemHash: fp.systemHash,
				toolsHash: fp.toolsHash,
				itemHashes: fp.itemHashes,
			}).slice(0, 12),
		);
	});
});

