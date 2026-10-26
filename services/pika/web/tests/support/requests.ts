// Captured request payloads in each provider's wire shape, as `GET requests/:id` returns them.
import type { ModelRequest } from "../../src/lib/types";

const SYSTEM = [
	"You are an expert coding assistant.",
	"",
	"<tools>",
	"- read: Read file contents",
	"</tools>",
	"",
	"# Project Context",
	"Use conventional commits.",
].join("\n");

export function modelRequest(id: string, payload: unknown, extra: Partial<ModelRequest> = {}): ModelRequest {
	return {
		id,
		sessionId: "s1",
		fidelity: "payload",
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-sonnet-4-5",
		at: "2026-10-20T09:00:02.000Z",
		complete: true,
		payload,
		...extra,
	};
}

export const anthropicPayload = {
	model: "claude-sonnet-4-5",
	max_tokens: 32000,
	system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
	tools: [{ name: "read", description: "Read the contents of a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
	messages: [
		{ role: "user", content: "Fix the failing test" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Look at api.ts first.", signature: "sig" },
				{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "src/api.ts" } },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export const base = '/';" }] },
	],
};

export const openAiChatPayload = {
	model: "gpt-5",
	stream: true,
	messages: [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: [{ type: "text", text: "Fix the failing test" }] },
		{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"src/api.ts"}' } }] },
		{ role: "tool", tool_call_id: "call_1", content: "export const base = '/';" },
	],
	tools: [{ type: "function", function: { name: "read", description: "Read the contents of a file.", parameters: { type: "object" } } }],
};

export const openAiResponsesPayload = {
	model: "gpt-5-codex",
	instructions: SYSTEM,
	input: [
		{ role: "user", content: [{ type: "input_text", text: "Fix the failing test" }] },
		{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Read api.ts." }] },
		{ type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"src/api.ts"}' },
		{ type: "function_call_output", call_id: "call_1", output: "export const base = '/';" },
	],
	tools: [{ type: "function", name: "read", description: "Read the contents of a file.", parameters: { type: "object" } }],
	reasoning: { effort: "high" },
};

export const googlePayload = {
	model: "gemini-2.5-pro",
	contents: [
		{ role: "user", parts: [{ text: "Fix the failing test" }] },
		{ role: "model", parts: [{ functionCall: { name: "read", args: { path: "src/api.ts" } } }] },
		{ role: "user", parts: [{ functionResponse: { name: "read", response: { output: "export const base = '/';" } } }] },
	],
	config: {
		systemInstruction: SYSTEM,
		tools: [{ functionDeclarations: [{ name: "read", description: "Read the contents of a file.", parameters: { type: "object" } }] }],
		temperature: 0.2,
	},
};

export const piContextPayload = {
	messages: [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: "Fix the failing test", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/api.ts" } }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "export const base = '/';" }], isError: false, timestamp: 3 },
	],
};
