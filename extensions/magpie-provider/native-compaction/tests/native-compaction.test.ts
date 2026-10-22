import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	isEligibleModel,
	type NativeCompactionConfig,
} from "../types.ts";
import {
	buildCompactHeaders,
	buildCompactRequestBody,
	buildRemoteCompactionV2ReplacementHistory,
	callRemoteCompaction,
	effectiveInputForBranch,
	findNativeCheckpoint,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	parseCompactResponse,
	resolveCompactUrl,
	shouldFallbackToBuiltinCompaction,
} from "../native-compaction.ts";

const model = {
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
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
	models: [model.id],
	fallbackToBuiltin: true,
};

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
		expect(headers.get("accept")).toBe("text/event-stream, application/json");
		expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
	});

	it("appends the documented compaction_trigger to canonical input", () => {
		const input = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }];
		expect(buildCompactRequestBody(model, input)).toEqual({
			model: "gpt-6-luna",
			stream: true,
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
			model: "gpt-6-luna",
			stream: true,
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

describe.each(["compaction", "custom"] as const)("%s checkpoint context edits", (checkpointType) => {
	function sessionWithCheckpoint() {
		const session = SessionManager.inMemory();
		const beforeId = session.appendMessage({ role: "user", content: "pre-checkpoint history", timestamp: 0 });
		const replacementHistory = [
			{ role: "user", content: [{ type: "input_text", text: "retained canonical input" }] },
			{ type: "compaction", encrypted_content: "opaque" },
		];
		const details = {
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			endpoint: "responses",
			modelKey: modelKey(model),
			replacementHistory,
		};
		if (checkpointType === "compaction") {
			// A full-branch projection would incorrectly restore this retained raw entry.
			session.appendCompaction("native marker", beforeId, 100, details);
		} else {
			session.appendCustomEntry(NATIVE_COMPACTION_KIND, details);
		}
		return { session, beforeId, replacementHistory };
	}

	it("preserves the checkpoint with no tail", () => {
		const { session, replacementHistory } = sessionWithCheckpoint();
		expect(effectiveInputForBranch({ branch: session.getBranch(), model, tools: [] })).toEqual(replacementHistory);
	});

	it("appends an unchanged tail despite its missing checkpoint parent in the projection", () => {
		const { session, replacementHistory } = sessionWithCheckpoint();
		session.appendMessage({ role: "user", content: "tail", timestamp: 1 });
		expect(effectiveInputForBranch({ branch: session.getBranch(), model, tools: [] })).toEqual([
			...replacementHistory,
			{ role: "user", content: [{ type: "input_text", text: "tail" }] },
		]);
	});

	it.each(["metadata", "context edit"])("preserves tail connectivity when an excluded error precedes %s", (following) => {
		const { session, replacementHistory } = sessionWithCheckpoint();
		const targetId = session.appendMessage({ role: "user", content: "important tail", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage("failed response", { stopReason: "error" }));
		if (following === "metadata") session.appendCustomEntry("metadata", {});
		else session.appendContextEdit(targetId, { content: "edited tail" });
		const branch = session.getBranch();
		const original = structuredClone(branch);
		expect(effectiveInputForBranch({ branch, model, tools: [], excludeLastAssistantError: true })).toEqual([
			...replacementHistory,
			{ role: "user", content: [{ type: "input_text", text: following === "metadata" ? "important tail" : "edited tail" }] },
		]);
		expect(branch).toEqual(original);
	});

	it("omits an edited tail message without changing the checkpoint or raw history", () => {
		const { session, replacementHistory } = sessionWithCheckpoint();
		const targetId = session.appendMessage({ role: "user", content: "omit me", timestamp: 1 });
		session.appendContextEdit(targetId, null);
		const branch = session.getBranch();
		const original = structuredClone(branch);
		expect(effectiveInputForBranch({ branch, model, tools: [] })).toEqual(replacementHistory);
		expect(branch).toEqual(original);
	});

	it.each([false, true])("does not replay an omitted length-recovery tool call or result (exclude error: %s)", (excludeLastAssistantError) => {
		const { session, replacementHistory } = sessionWithCheckpoint();
		session.appendMessage({ role: "user", content: "retry this request", timestamp: 1 });
		const assistantId = session.appendMessage(fauxAssistantMessage({
			type: "toolCall", id: "truncated-call", name: "read", arguments: { path: "abandoned.txt" },
		}, { stopReason: "length" }));
		const resultId = session.appendMessage({
			role: "toolResult", toolCallId: "truncated-call", toolName: "read",
			content: [{ type: "text", text: "abandoned result" }], isError: true, timestamp: 2,
		});
		// Pi 1.4 recovery omits both sides of the abandoned attempt from model context.
		session.appendContextEdit(assistantId, null);
		session.appendContextEdit(resultId, null);
		const branch = session.getBranch();
		const original = structuredClone(branch);
		expect(effectiveInputForBranch({ branch, model, tools: [], excludeLastAssistantError })).toEqual([
			...replacementHistory,
			{ role: "user", content: [{ type: "input_text", text: "retry this request" }] },
		]);
		expect(branch).toEqual(original);
	});

	it("uses the latest tail replacement without resurrecting edited pre-checkpoint entries", () => {
		const { session, beforeId, replacementHistory } = sessionWithCheckpoint();
		const targetId = session.appendMessage({ role: "user", content: "original tail", timestamp: 1 });
		session.appendContextEdit(targetId, { content: "first replacement" });
		session.appendContextEdit(targetId, null);
		session.appendContextEdit(targetId, { content: "latest replacement" });
		session.appendContextEdit(beforeId, { content: "must not reappear" });
		expect(effectiveInputForBranch({ branch: session.getBranch(), model, tools: [] })).toEqual([
			...replacementHistory,
			{ role: "user", content: [{ type: "input_text", text: "latest replacement" }] },
		]);
	});
});

describe("provider-neutral configuration", () => {
	const magpieModel = {
		...model,
		provider: "magpie",
		api: "openai-responses",
		id: "codex/gpt-6-luna",
		baseUrl: "http://127.0.0.1:3425/v1",
	};
	const magpieConfig = {
		...config,
		providerId: "magpie",
		apiId: "openai-responses",
		models: [magpieModel.id],
	};

	it("requires explicit retargeting and an exact Responses model", () => {
		expect(isEligibleModel(magpieModel, config)).toBe(false);
		expect(isEligibleModel(magpieModel, magpieConfig)).toBe(true);
		expect(isEligibleModel({ ...magpieModel, api: "openai-completions" }, magpieConfig)).toBe(false);
		expect(isEligibleModel({ ...magpieModel, id: "group/fast" }, magpieConfig)).toBe(false);
		expect(isEligibleModel(model, magpieConfig)).toBe(false);
	});

	it("uses the inline JSON contract and replays its checkpoint only on the same model", async () => {
		const input = [{ role: "user", content: [{ type: "input_text", text: "remember this" }] }];
		const opaque = { type: "compaction", encrypted_content: "upstream-sealed-checkpoint" };
		const remote = await callRemoteCompaction({
			url: resolveCompactUrl(magpieModel.baseUrl),
			headers: buildCompactHeaders({ apiKey: "magpie-pi", sessionId: "test-session" }),
			body: buildCompactRequestBody(magpieModel, input),
			model: magpieModel,
			fetchImpl: (async (url, init) => {
				expect(url).toBe("http://127.0.0.1:3425/v1/responses");
				expect(init?.redirect).toBe("error");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer magpie-pi");
				expect(JSON.parse(String(init?.body))).toEqual({
					model: magpieModel.id,
					stream: true,
					instructions: "",
					input: [...input, { type: "compaction_trigger" }],
				});
				return Response.json({ output: [opaque] });
			}) as typeof fetch,
		});
		expect(remote.replacementHistory).toEqual([...input, opaque]);
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({ role: "user", content: "remember this", timestamp: 0 });
		session.appendCompaction("native marker", firstId, 100, {
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			endpoint: "responses",
			modelKey: modelKey(magpieModel),
			replacementHistory: remote.replacementHistory,
		});
		session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		const branch = session.getBranch();
		expect(effectiveInputForBranch({ branch, model: magpieModel, tools: [] })).toEqual([
			...input, opaque, { role: "user", content: [{ type: "input_text", text: "continue" }] },
		]);
		expect(() => effectiveInputForBranch({ branch, model, tools: [] })).toThrow();
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
					modelKey: "cliproxyapi:cliproxyapi-codex-responses:gpt-6-luna",
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
						message: "auth_unavailable: no auth available (providers=codex,openai-compatible-minimax router, model=gpt-6-luna)",
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
				body: { model: "gpt-6-luna", input: [] },
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

describe("streamed remote compaction", () => {
	const opaque = { type: "compaction", encrypted_content: "sealed-✓" };
	const completed = { type: "response.completed", response: {
		status: "completed", output: [opaque], usage: { input_tokens: 10, output_tokens: 5 },
	} };
	const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
	const request = {
		url: "http://magpie.example/v1/responses",
		headers: buildCompactHeaders({ apiKey: "gateway-key", sessionId: "session" }),
		body: buildCompactRequestBody({ ...model, id: "codex/gpt-6.1-sol" }, []),
		model,
	};
	function streamResponse(text: string, leaveOpen = false) {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// Split even CRLF and multibyte UTF-8 characters across reads.
				for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
				if (!leaveOpen) controller.close();
			},
			cancel,
		});
		return { response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }), body, cancel };
	}

	it("passes Magpie's stream-only Codex native relay gate and consumes completed output", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			if (JSON.parse(String(init?.body)).stream !== true) {
				return new Response("Codex doesn't serve gpt-6.1-sol on the Responses API, so Codex's native compaction can't be asked of it", { status: 400 });
			}
			expect(new Headers(init?.headers).get("accept")).toContain("text/event-stream");
			return streamResponse(frame({ type: "response.output_item.done", item: opaque }) + frame(completed)).response;
		});
		await expect(callRemoteCompaction({ ...request, body: { ...request.body, stream: false }, fetchImpl }))
			.rejects.toThrow("Codex doesn't serve gpt-6.1-sol on the Responses API");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const result = await callRemoteCompaction({ ...request, fetchImpl });
		expect(result.replacementHistory).toEqual([opaque]);
		expect(result.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it.each(["\n", "\r\n", "\r"])("decodes split multiline frames with %j and cancels after completion", async (newline) => {
		const text = [": heartbeat", "id: ignored", "event: response.completed",
			'data: {"type":"response.completed",', `data: "response":${JSON.stringify(completed.response)}}`, "", ""].join(newline);
		// An extra comment resolves the last CR without closing the stream.
		const { response, body, cancel } = streamResponse(text + ": still open\n", true);
		await expect(callRemoteCompaction({ ...request, fetchImpl: async () => response }))
			.resolves.toMatchObject({ replacementHistory: [opaque] });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it.each([
		["partial output only", frame({ type: "response.output_item.done", item: opaque })],
		["DONE without completion", "data: [DONE]\n\n"],
		["malformed JSON", "data: {bad}\n\n"],
		["non-object", "data: null\n\n"],
		["unterminated frame", frame(completed).trimEnd()],
		["failed", frame({ type: "response.failed", response: completed.response })],
		["incomplete", frame({ type: "response.incomplete", response: completed.response })],
		["error", frame({ type: "error", message: "upstream error" })],
		["response error", frame({ type: "response.error", error: { message: "upstream error" } })],
		["failed completed status", frame({ ...completed, response: { ...completed.response, status: "failed" } })],
		["completed response error", frame({ ...completed, response: { ...completed.response, error: { message: "failed" } } })],
		["missing opaque item", frame({ ...completed, response: { output: [] } })],
		["conflicting event type", `event: response.failed\n${frame(completed)}`],
	])("fails closed for %s, preserving bounded retries and releasing readers", async (_name, text) => {
		vi.useFakeTimers();
		const bodies: ReadableStream[] = [];
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			const { response, body } = streamResponse(text);
			bodies.push(body);
			return response;
		});
		try {
			const assertion = expect(callRemoteCompaction({ ...request, fetchImpl })).rejects.toThrow();
			await vi.runAllTimersAsync();
			await assertion;
			expect(fetchImpl).toHaveBeenCalledTimes(3);
			expect(bodies.every((body) => !body.locked)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels an open malformed stream on every failed attempt", async () => {
		vi.useFakeTimers();
		const streams: ReturnType<typeof streamResponse>[] = [];
		try {
			const assertion = expect(callRemoteCompaction({ ...request, fetchImpl: async () => {
				const stream = streamResponse("data: {bad}\n\n", true);
				streams.push(stream);
				return stream.response;
			} })).rejects.toThrow();
			await vi.runAllTimersAsync();
			await assertion;
			expect(streams).toHaveLength(3);
			for (const { body, cancel } of streams) {
				expect(cancel).toHaveBeenCalledOnce();
				expect(body.locked).toBe(false);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("cleans up a stream when already aborted", async () => {
		const reason = new Error("already cancelled");
		const { response, body, cancel } = streamResponse("", true);
		const fetchImpl = vi.fn<typeof fetch>(async () => response);
		await expect(callRemoteCompaction({ ...request, signal: AbortSignal.abort(reason), fetchImpl })).rejects.toBe(reason);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("propagates abort during a pending read without retrying and cancels the stream", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel compaction");
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			pull() { controller.abort(reason); },
			cancel,
		}, { highWaterMark: 0 });
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			expect(init?.signal).toBe(controller.signal);
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		});
		await expect(callRemoteCompaction({ ...request, signal: controller.signal, fetchImpl })).rejects.toBe(reason);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});
});
