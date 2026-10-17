import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeContext, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createMagpieProvider, parseModels, readConfig } from "../index.ts";

// Real Pi API modules and SDKs, with all HTTP intercepted at the fetch boundary.
const chatSse = [
	{ id: "chat-1", object: "chat.completion.chunk", created: 0, model: "chat-model", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
	{ id: "chat-1", object: "chat.completion.chunk", created: 0, model: "chat-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
const messagesSse = [
	{ type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

let agentDirectory: string;
beforeEach(() => { agentDirectory = mkdtempSync(join(tmpdir(), "magpie-affinity-")); vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(agentDirectory, { recursive: true, force: true }); });

for (const method of ["stream", "streamSimple"] as const) {
	it.each([
		["/v1/chat/completions", "chat-model", chatSse],
		["/v1/messages", "claude-sonnet-4-6", messagesSse],
	])(`${method} sends Magpie session affinity through the real delegate for %s`, async (endpoint, id, sse) => {
		const unexpectedFetch = vi.fn(() => { throw new Error("Unexpected unmocked network request"); });
		vi.stubGlobal("fetch", unexpectedFetch);
		const requests: Request[] = [];
		const mockedFetch: typeof fetch = vi.fn(async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});
		const config = readConfig({});
		const provider = createMagpieProvider({});
		const model = parseModels({ data: [{ id, native_endpoints: [endpoint] }] }, config.origin)[0];
		const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
		const result = await provider[method](model, context, {
			apiKey: "test-key", sessionId: "magpie-session-123", cacheRetention: "short",
			fetch: mockedFetch, maxRetries: 0,
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Hello" }));
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0].url).origin).toBe(config.origin);
		expect(new URL(requests[0].url).pathname).toBe(endpoint);
		expect(requests[0].headers.get("x-session-affinity")).toBe("magpie-session-123");
		if (endpoint === "/v1/chat/completions") {
			expect(requests[0].headers.get("session_id")).toBe("magpie-session-123");
			expect(requests[0].headers.get("x-client-request-id")).toBe("magpie-session-123");
		} else {
			expect(model.compat).toEqual({ sendSessionAffinityHeaders: true, forceAdaptiveThinking: true });
		}
		expect(unexpectedFetch).not.toHaveBeenCalled();
	});
}

for (const method of ["stream", "streamSimple"] as const) {
	it.each([
		["/v1/chat/completions", "chat-model", chatSse],
		["/v1/messages", "claude-sonnet-4-6", messagesSse],
	])(`${method} pairs saved auth with a stale model endpoint through ModelRuntime: %s`, async (endpoint, id, sse) => {
		const directory = mkdtempSync(join(tmpdir(), "magpie-runtime-"));
		try {
			vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("magpie", async () => ({ type: "api_key", key: "new-key", env: { MAGPIE_BASE_URL: "https://new.example" } }));
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
			runtime.registerNativeProvider(createMagpieProvider({}));
			const stale = parseModels({ data: [{ id, native_endpoints: [endpoint] }] }, "https://old.example")[0];
			const requests: Request[] = [];
			const mockedFetch: typeof fetch = async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			};
			const onPayload = vi.fn();
			const onResponse = vi.fn();
			const onProviderStreamEvent = vi.fn();
			const result = await runtime[method](stale, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] }), {
				fetch: mockedFetch, maxRetries: 0, onPayload, onResponse, onProviderStreamEvent,
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(requests).toHaveLength(1);
			expect(new URL(requests[0].url).origin).toBe("https://new.example");
			expect(new URL(requests[0].url).pathname).toBe(endpoint);
			expect(requests[0].headers.get(endpoint === "/v1/messages" ? "x-api-key" : "authorization")).toBe(endpoint === "/v1/messages" ? "new-key" : "Bearer new-key");
			expect(stale.baseUrl).toContain("old.example");
			expect(onPayload).toHaveBeenCalled();
			expect(onResponse).toHaveBeenCalled();
			expect(onProviderStreamEvent).toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
}
