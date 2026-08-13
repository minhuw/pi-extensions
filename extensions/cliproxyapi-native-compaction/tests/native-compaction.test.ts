import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
	isEligibleModel,
	type NativeCompactionConfig,
} from "../config.ts";
import {
	buildCompactHeaders,
	buildCompactRequestBody,
	buildRemoteCompactionV2ReplacementHistory,
	callRemoteCompaction,
	findNativeCheckpoint,
	parseCompactResponse,
	resolveCompactUrl,
	shouldFallbackToBuiltinCompaction,
} from "../native-compaction.ts";

const model = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "cliproxyapi-codex-responses",
	provider: "cliproxyapi",
	baseUrl: "https://proxy.example/backend-api/",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 372000,
	maxTokens: 16384,
} as Model<any>;

const config: NativeCompactionConfig = {
	enabled: true,
	providerId: "cliproxyapi",
	apiId: "cliproxyapi-codex-responses",
	models: ["gpt-5.6-sol"],
	fallbackToBuiltin: true,
};

describe("model capability gate", () => {
	it("accepts only an explicitly allowlisted CLIProxyAPI Codex model", () => {
		expect(isEligibleModel(model, config)).toBe(true);
		expect(isEligibleModel({ ...model, id: "kimi-k3" }, config)).toBe(false);
		expect(isEligibleModel({ ...model, provider: "openai-compatible" }, config)).toBe(false);
		expect(isEligibleModel({ ...model, api: "openai-completions" }, config)).toBe(false);
	});
});

describe("compact endpoint transport", () => {
	it("derives the Responses endpoint used by remote compaction v2", () => {
		expect(resolveCompactUrl("https://proxy.example/backend-api/")).toBe(
			"https://proxy.example/backend-api/codex/responses",
		);
		expect(resolveCompactUrl("https://proxy.example/v1")).toBe("https://proxy.example/v1/responses");
	});

	it("rejects an explicitly configured legacy compact endpoint", () => {
		expect(() =>
			resolveCompactUrl(undefined, "https://proxy.example/backend-api/codex/responses/compact"),
		).toThrow(/legacy \/responses\/compact endpoint is unsafe/);
	});

	it("uses a plain CLIProxyAPI bearer key without a ChatGPT account header", () => {
		const headers = buildCompactHeaders({
			apiKey: "plain-cpa-key",
			headers: { "chatgpt-account-id": "must-be-removed", "x-extra": "kept" },
			sessionId: "session-1",
		});
		expect(headers.get("authorization")).toBe("Bearer plain-cpa-key");
		expect(headers.get("chatgpt-account-id")).toBeNull();
		expect(headers.get("x-extra")).toBe("kept");
		expect(headers.get("accept")).toBe("application/json");
		expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
	});

	it("appends the documented compaction_trigger to canonical input", () => {
		const input = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }];
		expect(buildCompactRequestBody(model, input)).toEqual({
			model: "gpt-5.6-sol",
			instructions: "",
			input: [...input, { type: "compaction_trigger" }],
		});
	});

	it("removes output-only status from replayed messages and reasoning", () => {
		const input = [
			{ type: "reasoning", id: "rs_1", status: "completed", summary: [], encrypted_content: "opaque" },
			{
				type: "message",
				role: "assistant",
				id: "msg_1",
				status: "completed",
				content: [{ type: "output_text", text: "hello", annotations: [] }],
			},
			{
				type: "tool_search_output",
				call_id: "search_1",
				execution: "client",
				status: "completed",
				tools: [],
			},
		];

		expect(buildCompactRequestBody(model, input)).toEqual({
			model: "gpt-5.6-sol",
			instructions: "",
			input: [
				{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
				{
					type: "message",
					role: "assistant",
					id: "msg_1",
					content: [{ type: "output_text", text: "hello", annotations: [] }],
				},
				{
					type: "tool_search_output",
					call_id: "search_1",
					execution: "client",
					status: "completed",
					tools: [],
				},
				{ type: "compaction_trigger" },
			],
		});
		expect(input[0]).toHaveProperty("status", "completed");
	});
});

describe("canonical compacted output", () => {
	it.each(["compaction", "compaction_summary"])("accepts the %s opaque item spelling", (type) => {
		const value = {
			object: "response.compaction",
			output: [
				{ id: "msg_1", type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ id: "cmp_1", type, encrypted_content: "opaque" },
			],
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		const parsed = parseCompactResponse(value);
		expect(parsed.output).toEqual(value.output);
		expect(parsed.output).not.toBe(value.output);
	});

	it("reconstructs the v2 window from retained user context plus the opaque item", () => {
		const input = [
			{ role: "user", content: [{ type: "input_text", text: "keep the original task" }] },
			{ type: "reasoning", encrypted_content: "old-reasoning" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "drop me" }] },
			{ type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "drop me too" },
			{ role: "user", content: [{ type: "input_text", text: "keep the latest instruction" }] },
		];
		const output = [{ type: "compaction", encrypted_content: "opaque" }];
		expect(buildRemoteCompactionV2ReplacementHistory(input, output)).toEqual([
			input[0],
			input[5],
			output[0],
		]);
	});

	it("truncates an oversized newest user message instead of keeping older context", () => {
		const oversized = "x".repeat(300_000);
		const output = [{ type: "compaction", encrypted_content: "opaque" }];
		const replacement = buildRemoteCompactionV2ReplacementHistory(
			[
				{ role: "user", content: [{ type: "input_text", text: "older task" }] },
				{ role: "user", content: [{ type: "input_text", text: oversized }] },
			],
			output,
		);
		expect(replacement).toHaveLength(2);
		expect(replacement[0]?.role).toBe("user");
		expect(((replacement[0]?.content as Array<{ text: string }>)[0]?.text ?? "").length).toBe(256_000);
		expect(replacement[1]).toEqual(output[0]);
	});

	it("charges retained images against the v2 budget", () => {
		const images = Array.from({ length: 65 }, (_, index) => ({
			type: "input_image",
			image_url: `data:image/png;base64,image-${index}`,
		}));
		const output = [{ type: "compaction", encrypted_content: "opaque" }];
		const replacement = buildRemoteCompactionV2ReplacementHistory(
			[{ role: "user", content: images }],
			output,
		);
		expect(replacement).toHaveLength(2);
		expect((replacement[0]?.content as unknown[]).length).toBe(62);
		expect(replacement[1]).toEqual(output[0]);
	});

	it("falls back to built-in compaction when native compact has not started", () => {
		expect(
			shouldFallbackToBuiltinCompaction({
				checkpoint: { status: "none" },
				fallbackToBuiltin: true,
			}),
		).toBe(true);
		expect(
			shouldFallbackToBuiltinCompaction({
				checkpoint: { status: "none" },
				fallbackToBuiltin: false,
			}),
		).toBe(false);
	});

	it("keeps legacy dedicated-endpoint checkpoints readable", () => {
		const checkpoint = findNativeCheckpoint([
			{
				type: "compaction",
				id: "cmp_1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "marker",
				firstKeptEntryId: "message_1",
				tokensBefore: 100,
				details: {
					kind: "cliproxyapi-openai-native-compaction",
					version: 1,
					modelKey: "cliproxyapi:cliproxyapi-codex-responses:gpt-5.6-sol",
					endpoint: "responses/compact",
					replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
				},
			} as any,
		]);
		expect(checkpoint.status).toBe("valid");
		expect(
			shouldFallbackToBuiltinCompaction({
				checkpoint,
				fallbackToBuiltin: true,
			}),
		).toBe(false);
	});

	it("returns the reconstructed v2 replacement history", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					output: [{ type: "compaction", encrypted_content: "opaque" }],
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		const input = [{ role: "user", content: [{ type: "input_text", text: "keep me" }] }];
		const result = await callRemoteCompaction({
			url: "https://proxy.example/backend-api/codex/responses",
			headers: new Headers(),
			body: buildCompactRequestBody(model, input),
			model,
			fetchImpl,
		});
		expect(result.replacementHistory).toEqual([
			input[0],
			{ type: "compaction", encrypted_content: "opaque" },
		]);
	});

	it("does not retry an auth_unavailable compact response", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					error: {
						message: "auth_unavailable: no auth available (providers=codex,openai-compatible-minimax router, model=gpt-5.6-sol)",
						type: "server_error",
						code: "internal_server_error",
					},
				}),
				{ status: 503, statusText: "Service Unavailable" },
			);
		};

		await expect(
			callRemoteCompaction({
				url: "https://proxy.example/backend-api/codex/responses",
				headers: new Headers(),
				body: { model: "gpt-5.6-sol", input: [] },
				model,
				fetchImpl,
			}),
		).rejects.toThrow(/auth_unavailable/);
		expect(calls).toBe(1);
	});

	it("rejects output without exactly one encrypted opaque item", () => {
		expect(() => parseCompactResponse({ output: [{ type: "message", role: "user", content: "hello" }] })).toThrow(
			"expected exactly one",
		);
		expect(() =>
			parseCompactResponse({
				output: [
					{ type: "compaction_summary", encrypted_content: "one" },
					{ type: "compaction", encrypted_content: "two" },
				],
			}),
		).toThrow("expected exactly one");
	});
});
