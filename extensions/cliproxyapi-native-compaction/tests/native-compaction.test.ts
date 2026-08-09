import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
	isEligibleModel,
	type NativeCompactionConfig,
} from "../config.ts";
import {
	buildCompactHeaders,
	buildCompactRequestBody,
	parseCompactResponse,
	resolveCompactUrl,
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
	it("derives the backend-api Codex compact route", () => {
		expect(resolveCompactUrl("https://proxy.example/backend-api/")).toBe(
			"https://proxy.example/backend-api/codex/responses/compact",
		);
		expect(resolveCompactUrl("https://proxy.example/v1")).toBe(
			"https://proxy.example/backend-api/codex/responses/compact",
		);
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
	});

	it("sends only the documented model and canonical input", () => {
		const input = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }];
		expect(buildCompactRequestBody(model, input)).toEqual({ model: "gpt-5.6-sol", input });
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
