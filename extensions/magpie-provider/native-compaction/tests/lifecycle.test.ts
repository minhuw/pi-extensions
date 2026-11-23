import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { registerNativeCompaction, type MagpieCompactionConfig } from "../lifecycle.ts";
import {
	MAX_COMPACT_RESPONSE_BYTES,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
} from "../native-compaction.ts";

const model = (provider = "magpie", id = "test-model"): Model<any> => ({
	provider, api: "openai-responses", id, name: "Test",
	baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
});
const opaque = { type: "compaction", encrypted_content: "sealed" };

function registration(overrides: Partial<MagpieCompactionConfig> = {}, brokenConfig = false) {
	const handlers: Record<string, (event: any, ctx: ExtensionContext) => any> = {};
	const commands: Record<string, any> = {};
	const config: MagpieCompactionConfig = {
		enabled: true, models: ["test-model"], fallbackToBuiltin: true, ...overrides,
	};
	const pi = {
		on: (name: string, handler: any) => { handlers[name] = handler; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		appendEntry: () => {},
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	registerNativeCompaction(pi, () => {
		if (brokenConfig) throw new Error("bad config");
		return config;
	});
	return { handlers, commands };
}

function fixture(
	current: string | Model<any> = "magpie",
	checkpoint?: string | Model<any>,
	malformed = false,
) {
	const currentModel = typeof current === "string" ? model(current) : current;
	const checkpointModel = typeof checkpoint === "string" ? model(checkpoint) : checkpoint;
	const session = SessionManager.inMemory();
	const firstId = session.appendMessage({ role: "user", content: "task", timestamp: 0 });
	if (checkpointModel) session.appendCompaction("marker", firstId, 100, {
		kind: NATIVE_COMPACTION_KIND, version: NATIVE_COMPACTION_VERSION, endpoint: "responses",
		modelKey: modelKey(checkpointModel), replacementHistory: malformed ? [] : [opaque],
	});
	const abort = vi.fn();
	const notify = vi.fn();
	const auth = vi.fn(async () => ({ ok: true, apiKey: "secret", headers: {} }));
	const ctx = {
		model: currentModel, sessionManager: session, abort, hasUI: true, ui: { notify },
		modelRegistry: { getApiKeyAndHeaders: auth },
	} as unknown as ExtensionContext;
	const event = {
		type: "session_before_compact", branchEntries: session.getBranch(), reason: "manual", willRetry: false,
		preparation: { firstKeptEntryId: firstId, tokensBefore: 100 }, signal: new AbortController().signal,
	};
	const payload = { model: currentModel.id, input: ["stale"], messages: ["stale"], previous_response_id: "stale" };
	return { ctx, event, payload, abort, notify, auth };
}

afterEach(() => vi.unstubAllGlobals());

describe("Magpie-owned lifecycle", () => {
	it("replays, strips local markers, and compacts healthy Magpie checkpoints", async () => {
		const { handlers } = registration();
		const f = fixture("magpie", "magpie");
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ output: [opaque] }));
		vi.stubGlobal("fetch", fetchMock);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx)).toEqual({ model: "test-model", input: [opaque] });
		expect(handlers.context!({ messages: [{ role: "compactionSummary" }, { role: "user" }] }, f.ctx)).toEqual({
			messages: [{ role: "user" }],
		});
		const compact = await handlers.session_before_compact!(f.event, f.ctx);
		expect(compact.compaction.details.modelKey).toBe(modelKey(model("magpie")));
		expect(compact.compaction.summary).toContain("Magpie");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/responses");
		expect(f.abort).not.toHaveBeenCalled();
	});

	it("ignores non-Magpie sessions without native checkpoints", async () => {
		const { handlers } = registration();
		const f = fixture("other");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx)).toBeUndefined();
		expect(handlers.context!({ messages: [{ role: "compactionSummary" }, { role: "user" }] }, f.ctx)).toBeUndefined();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(f.abort).not.toHaveBeenCalled();
	});

	it("resolves Magpie selection aliases to their physical checkpoint and request target", async () => {
		const target = model("magpie", "auto/gpt-6-astra");
		const alias = { ...target, id: "gpt-6-astra", magpieAliasTarget: target.id };
		const { handlers } = registration({ models: [target.id] });
		const f = fixture(alias, target);
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ output: [opaque] }));
		vi.stubGlobal("fetch", fetchMock);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx)).toEqual({ model: alias.id, input: [opaque] });
		const compact = await handlers.session_before_compact!(f.event, f.ctx);
		expect(compact.compaction.details.modelKey).toBe(modelKey(target));
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe(target.id);
		expect(f.abort).not.toHaveBeenCalled();
	});

	it.each([{ enabled: false }, { models: [] }])("replays existing checkpoints despite %j, but creates no new ones", async (config) => {
		const { handlers } = registration(config);
		const f = fixture("magpie", "magpie");
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([opaque]);
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
		const fresh = fixture("magpie");
		expect(await handlers.session_before_compact!(fresh.event, fresh.ctx)).toBeUndefined();
	});

	it.each([
		["magpie", "other"],
		["other", "magpie"],
	])("blocks model/checkpoint mismatch %s/%s", async (current, checkpoint) => {
		const { handlers } = registration();
		const f = fixture(current, checkpoint);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx)).toEqual({ model: "test-model", input: [] });
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it("fails closed on malformed recognized checkpoints in Magpie scope", async () => {
		const { handlers } = registration();
		const f = fixture("magpie", "magpie", true);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([]);
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it.each([false, true])("guards foreign history after its owning extension is removed (malformed=%s)", async (malformed) => {
		const { handlers } = registration();
		const f = fixture("third-party", "removed-provider", malformed);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([]);
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it("fails closed on malformed foreign checkpoints even when the foreign provider matches", async () => {
		const { handlers } = registration();
		const f = fixture("removed-provider", "removed-provider", true);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([]);
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it("cancels rather than throwing on configuration errors", async () => {
		const { handlers } = registration({}, true);
		const f = fixture("magpie");
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it.each([
		{ checkpoint: undefined, fallbackToBuiltin: true, expected: undefined },
		{ checkpoint: undefined, fallbackToBuiltin: false, expected: { cancel: true } },
		{ checkpoint: "magpie", fallbackToBuiltin: true, expected: { cancel: true } },
	])("limits failure fallback: %j", async ({ checkpoint, fallbackToBuiltin, expected }) => {
		const { handlers } = registration({ fallbackToBuiltin });
		const f = fixture("magpie", checkpoint);
		f.auth.mockRejectedValue(new Error("authentication failed"));
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual(expected);
	});

	it("cancels an aborted compaction without falling back", async () => {
		const { handlers } = registration();
		const f = fixture("magpie");
		f.event.signal = AbortSignal.abort();
		f.auth.mockRejectedValue(new Error("aborted"));
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
	});

	it("registers /magpie-native-compaction and retains argument validation", async () => {
		const { commands } = registration();
		const f = fixture("magpie");
		await commands["magpie-native-compaction"].handler("unexpected", f.ctx);
		expect(f.notify).toHaveBeenLastCalledWith("Usage: /magpie-native-compaction", "error");
		await commands["magpie-native-compaction"].handler("", f.ctx);
		expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Enabled for magpie/test-model"), "info");
	});

	it("sanitizes upstream HTTP error bodies in UI notifications for both fallback and cancel paths", async () => {
		const secretToken = "synthetic-lifecycle-secret-token";
		const statusSecret = "synthetic-status-secret";
		const fetchMock = vi.fn<typeof fetch>(async () =>
			new Response(
				JSON.stringify({ error: { message: `auth_unavailable: secret=${secretToken}` } }),
				{ status: 503, statusText: statusSecret },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { handlers: fallbackHandlers } = registration({ fallbackToBuiltin: true });
		const fresh = fixture("magpie");
		expect(await fallbackHandlers.session_before_compact!(fresh.event, fresh.ctx)).toBeUndefined();
		expect(fresh.notify).toHaveBeenCalledWith(
			"Magpie native compaction failed; falling back to Pi's built-in summarizer. HTTP 503 (auth_unavailable).",
			"warning",
		);
		expect(String(fresh.notify.mock.calls[0]?.[0])).not.toContain(secretToken);
		expect(String(fresh.notify.mock.calls[0]?.[0])).not.toContain(statusSecret);

		const { handlers: strictHandlers } = registration({ fallbackToBuiltin: false });
		const strict = fixture("magpie");
		expect(await strictHandlers.session_before_compact!(strict.event, strict.ctx)).toEqual({ cancel: true });
		expect(strict.notify).toHaveBeenCalledWith(
			"Magpie native compaction failed: HTTP 503 (auth_unavailable).",
			"error",
		);
		expect(String(strict.notify.mock.calls[0]?.[0])).not.toContain(secretToken);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("sanitizes SSE stream errors and oversized responses in UI notifications", async () => {
		const secretToken = "synthetic-stream-secret-token";
		const { handlers } = registration({ fallbackToBuiltin: false });

		const sseFetch = vi.fn<typeof fetch>(async () =>
			new Response(
				`data: ${JSON.stringify({ type: "error", error: { message: `auth_unavailable: ${secretToken}` } })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);
		vi.stubGlobal("fetch", sseFetch);
		const sseFixture = fixture("magpie");
		expect(await handlers.session_before_compact!(sseFixture.event, sseFixture.ctx)).toEqual({ cancel: true });
		expect(sseFixture.notify).toHaveBeenCalledWith("Magpie native compaction failed: auth_unavailable.", "error");
		expect(String(sseFixture.notify.mock.calls[0]?.[0])).not.toContain(secretToken);

		const cancel = vi.fn();
		const oversizedBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024));
			},
			cancel,
		});
		const oversizedFetch = vi.fn<typeof fetch>(async () =>
			new Response(oversizedBody, {
				status: 200,
				headers: {
					"content-type": "application/json",
					"content-length": String(MAX_COMPACT_RESPONSE_BYTES + 1),
				},
			}),
		);
		vi.stubGlobal("fetch", oversizedFetch);
		const oversizedFixture = fixture("magpie");
		expect(await handlers.session_before_compact!(oversizedFixture.event, oversizedFixture.ctx)).toEqual({ cancel: true });
		expect(oversizedFixture.notify).toHaveBeenCalledWith(
			"Magpie native compaction failed: response_too_large.",
			"error",
		);
		expect(cancel).toHaveBeenCalledOnce();
		expect(oversizedBody.locked).toBe(false);
	});
});
