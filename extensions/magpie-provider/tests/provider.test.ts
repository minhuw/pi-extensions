import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeContext, createModels, createAssistantMessageEventStream, type AssistantMessage, type ModelsPublication, type RefreshModelsContext, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magpie, { createMagpieProvider, discoverModels, parseModels, readConfig, DISCOVERY_TIMEOUT_MS } from "../index.ts";

const delegates = vi.hoisted(() => ({
	chat: { stream: vi.fn(), streamSimple: vi.fn() },
	responses: { stream: vi.fn(), streamSimple: vi.fn() },
	messages: { stream: vi.fn(), streamSimple: vi.fn() },
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
	builtinProviders: () => [
		{ id: "groq", getModels: () => [], ...delegates.chat },
		{ id: "openai", getModels: () => [], ...delegates.responses },
		{ id: "anthropic", getModels: () => [], ...delegates.messages },
	],
}));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({ ...await importOriginal<object>(), readStoredCredential: vi.fn() }));
const config = readConfig({});
const catalog = (id = "group/foo") => ({ data: [{ id }] });
const http = (body: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
const refresh = (overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
	allowNetwork: true, signal: new AbortController().signal,
	publish: vi.fn(async ({ update }: ModelsPublication) => { update?.(); return true; }), ...overrides,
});
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "magpie-provider-")); vi.stubEnv("PI_CODING_AGENT_DIR", directory); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("configuration", () => {
	it("normalizes origins and uses a dummy key only on loopback", () => {
		expect(config).toEqual({ origin: "http://127.0.0.1:3425", apiKey: "magpie-pi" });
		for (const host of ["localhost", "127.0.0.2", "[::1]"]) {
			expect(readConfig({ MAGPIE_BASE_URL: `http://${host}:3425/v1/` }).origin).toBe(`http://${host}:3425`);
		}
		expect(readConfig({ MAGPIE_BASE_URL: "https://gateway.example/v1", MAGPIE_API_KEY: "secret" })).toEqual({ origin: "https://gateway.example", apiKey: "secret" });
	});
	it.each(["https://remote.example", "http://127.evil.example", "http://localhost.example"])("requires an explicit remote key: %s", url => {
		expect(readConfig({ MAGPIE_BASE_URL: url }).apiKey).toBeUndefined();
	});
	it.each(["bad", "ftp://localhost", "http://user:secret@localhost", "http://localhost?", "http://localhost#", "http://localhost/v1/models", "http://localhost/prefix"])("rejects unsafe URL: %s", url => {
		expect(() => readConfig({ MAGPIE_BASE_URL: url })).toThrow("MAGPIE_BASE_URL");
	});
});

describe("metadata", () => {
	it("keeps exact IDs, chooses native APIs, maps efforts and advertised images", () => {
		const models = parseModels({ data: [
			{ id: "group/foo", display_name: "Group", reasoning_levels: ["none", "high"], modalities: { input: ["image"] }, context_window: 10000, max_output_tokens: 20000 },
			{ id: "vendor/gpt", native_endpoints: ["/v1/messages", "/v1/responses"] },
			{ id: "vendor/claude-opus-4-6", native_endpoints: ["/v1/messages"], supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] },
			{ id: "glm", native_endpoints: ["/v1/messages"], reasoning_levels: ["high"] },
		] }, config.origin);
		expect(models[0]).toMatchObject({ id: "group/foo", name: "Group", api: "openai-completions", input: ["text", "image"], contextWindow: 10000, maxTokens: 10000,
			thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null } });
		expect(models[1]).toMatchObject({ api: "openai-responses", baseUrl: `${config.origin}/v1`, input: ["text"] });
		expect(models[2]).toMatchObject({ api: "anthropic-messages", baseUrl: config.origin, compat: { forceAdaptiveThinking: true } });
		expect(models[2].thinkingLevelMap).not.toHaveProperty("off");
		expect(models[3].thinkingLevelMap?.off).toBeNull();
		expect(models[3].compat).toEqual({ sendSessionAffinityHeaders: true });
		expect(models[0].compat).toEqual({ sendSessionAffinityHeaders: true });
		expect(models[1].compat).toBeUndefined();
	});
	it("validates entries, deduplicates, excludes non-chat outputs and uses conservative limits", () => {
		const [model, older] = parseModels({ data: [null, {}, { id: " " }, { id: 4 },
			{ id: "image", modalities: { output: ["image"] } }, { id: "audio", modalities: { output: ["audio"] } },
			{ id: "ok", context_window: Number.MAX_SAFE_INTEGER + 1, max_output_tokens: -1, reasoning: "true", modalities: { input: "image" } },
			{ id: "ok", display_name: "duplicate" }, { id: "claude-3-7-sonnet", native_endpoints: ["/v1/messages"], reasoning: true },
		] }, config.origin);
		expect(model).toMatchObject({ id: "ok", name: "ok", contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(older.compat).toEqual({ sendSessionAffinityHeaders: true });
		expect(older.thinkingLevelMap).toBeUndefined();
	});
	it("retains mixed bare and qualified rows without fabricating aliases or rewriting routing IDs", () => {
		const metadata = { display_name: "Direct model", owned_by: "codex", native_endpoints: ["/v1/responses"],
			context_window: 123456, max_output_tokens: 12345, modalities: { input: ["text", "image"] },
			supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }] };
		const models = parseModels({ data: [
			{ ...metadata, id: "gpt-5.4" }, { ...metadata, id: "codex/gpt-5.4", owned_by: "anthropic" },
			{ id: "routing-choice", owned_by: "codex" },
		] }, config.origin);
		expect(models.map(model => model.id)).toEqual(["gpt-5.4", "codex/gpt-5.4", "routing-choice"]);
		const { magpieRoute: bareRoute, ...bare } = models[0];
		const { magpieRoute: qualifiedRoute, ...qualifiedModel } = models[1];
		expect(bare).toEqual({ ...qualifiedModel, id: "gpt-5.4" });
		expect(bareRoute).toEqual({ canonicalId: "gpt-5.4", owner: "codex", group: false });
		expect(qualifiedRoute).toEqual({ canonicalId: "codex/gpt-5.4", owner: "anthropic", group: false });
		const [qualified] = parseModels({ data: [{ ...metadata, id: "codex/gpt-5.4" }] }, config.origin);
		const { magpieRoute: _route, ...publicQualified } = qualified;
		expect(qualifiedModel).toEqual(publicQualified);
	});
	it.each([null, [], {}, { data: {} }, { data: [] }, { data: [null] }])("rejects malformed or unusable catalog %j", body => {
		expect(() => parseModels(body, config.origin)).toThrow();
	});
});

describe("discovery and lifecycle", () => {
	it("authenticates without following redirects", async () => {
		http(catalog());
		await discoverModels(config);
		expect(fetch).toHaveBeenCalledWith(`${config.origin}/v1/models`, expect.objectContaining({ headers: { Authorization: "Bearer magpie-pi" }, redirect: "error", signal: expect.any(AbortSignal) }));
	});
	it.each([401, 500, 302])("rejects HTTP %s without leaking bodies", async status => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("SECRET", { status })));
		await expect(discoverModels(config)).rejects.toThrow("Magpie model discovery failed");
	});
	it("sanitizes malformed JSON and network failures", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("SECRET")));
		await expect(discoverModels(config)).rejects.toThrow("Magpie model discovery failed");
		vi.mocked(fetch).mockRejectedValue(new Error("SECRET"));
		await expect(discoverModels(config)).rejects.toThrow("Magpie model discovery failed");
	});
	it("honors cancellation before and during HTTP", async () => {
		vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
		const controller = new AbortController();
		const pending = discoverModels(config, controller.signal);
		controller.abort(new Error("SECRET"));
		await expect(pending).rejects.toThrow("cancelled");
		vi.mocked(fetch).mockClear();
		await expect(discoverModels(config, controller.signal)).rejects.toThrow("cancelled");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("bounds stalled HTTP with a timeout", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
		await expect(discoverModels(config)).rejects.toThrow("timed out");
		expect(timeout).toHaveBeenCalledWith(DISCOVERY_TIMEOUT_MS);
	}, 5000);
	it("publishes only on success, obeys allowNetwork and effective credentials", async () => {
		const provider = createMagpieProvider({});
		http(catalog());
		await provider.refreshModels!(refresh({ allowNetwork: false }));
		expect(fetch).not.toHaveBeenCalled();
		const ctx = refresh({ credential: { type: "api_key", key: "effective" } });
		await provider.refreshModels!(ctx);
		expect(ctx.publish).toHaveBeenCalledWith({ update: expect.any(Function) });
		expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer effective" });
		const previous = provider.getModels();
		for (const body of [{}, { data: [] }]) {
			http(body);
			await expect(provider.refreshModels!(refresh({ credential: { type: "api_key", key: "effective" } }))).rejects.toThrow();
			expect(provider.getModels()).toBe(previous);
		}
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		await expect(provider.refreshModels!(refresh({ credential: { type: "api_key", key: "effective" } }))).rejects.toThrow();
		expect(provider.getModels()).toBe(previous);
		http(catalog("new"));
		await provider.refreshModels!(refresh({ publish: async () => false }));
		expect(provider.getModels()).toBe(previous);
	});
	it("refreshes bare model API metadata through the native model registry", async () => {
		const models = createModels();
		models.setProvider(createMagpieProvider({}));
		http({ data: [{ id: "gpt-6-astra", owned_by: "codex", native_endpoints: ["/v1/responses"] }] });
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModel("magpie", "gpt-6-astra")).toMatchObject({
			id: "gpt-6-astra", api: "openai-responses",
		});
		// A bare route can become a group and lose its Responses advertisement.
		http({ data: [{ id: "gpt-6-astra", owned_by: "codex" }] });
		expect((await models.refresh({ force: true })).errors.size).toBe(0);
		const group = models.getModel("magpie", "gpt-6-astra");
		expect(group?.api).toBe("openai-completions");
	});
	it("reports refresh errors through native Models and preserves existing catalog", async () => {
		const models = createModels();
		models.setProvider(createMagpieProvider({}));
		http(catalog());
		expect((await models.refresh()).errors.size).toBe(0);
		http({ data: [] });
		expect((await models.refresh()).errors.has("magpie")).toBe(true);
		expect(models.getModel("magpie", "group/foo")).toBeDefined();
	});
	it.each(["1", "true", "TRUE", "yes", "YES"])("registers without startup HTTP when PI_OFFLINE=%s", async offline => {
		vi.stubEnv("PI_OFFLINE", offline);
		vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:3425");
		vi.stubEnv("MAGPIE_API_KEY", "");
		http(catalog());
		const registerProvider = vi.fn();
		await magpie({ registerProvider, on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);
		expect(fetch).not.toHaveBeenCalled();
		expect(registerProvider).toHaveBeenCalledOnce();
		const provider = registerProvider.mock.calls[0][0] as Provider;
		expect(provider.id).toBe("magpie");
		expect(provider.getModels()).toEqual([]);
	});
	it.each([undefined, "0", "false", "no"])("discovers at startup for non-offline PI_OFFLINE=%s", async offline => {
		vi.stubEnv("PI_OFFLINE", offline);
		vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:3425");
		http(catalog());
		await magpie({ registerProvider: vi.fn(), on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);
		expect(fetch).toHaveBeenCalledOnce();
	});
	it("awaits initial discovery before registration, but registers empty when unavailable", async () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:3425");
		vi.stubEnv("MAGPIE_API_KEY", "");
		const registered: Provider[] = [];
		const pi = { registerProvider: (provider: Provider) => registered.push(provider), on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI;
		http(catalog());
		await magpie(pi);
		expect(registered[0].getModels()[0].id).toBe("group/foo");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		await magpie(pi);
		expect(registered[1].getModels()).toEqual([]);
		vi.stubEnv("MAGPIE_BASE_URL", "https://remote.example");
		await magpie(pi);
		expect(registered).toHaveLength(3);
		expect(registered[2].getModels()).toEqual([]);
	});
	it("resolves stored/runtime credentials before environment and default", async () => {
		const provider = createMagpieProvider({});
		const ctx = { env: async (name: string) => name === "MAGPIE_API_KEY" ? "env-key" : undefined, fileExists: async () => false };
		const resolve = provider.auth.apiKey!.resolve;
		expect((await resolve({ ctx, signal: new AbortController().signal, credential: { type: "api_key", key: "stored" } }))?.auth.apiKey).toBe("stored");
		expect((await resolve({ ctx, signal: new AbortController().signal }))?.auth.apiKey).toBe("env-key");
	});
});

it("records session pricing provenance for usage that Pi may merge into a summary", async () => {
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:3425");
	const registerProvider = vi.fn();
	const appendEntry = vi.fn();
	await magpie({ registerProvider, appendEntry, on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);
	const provider = registerProvider.mock.calls[0][0] as Provider;
	const [model] = parseModels(catalog(), config.origin);
	const source = createAssistantMessageEventStream();
	const message: AssistantMessage = { role: "assistant", provider: "magpie", model: model.id, api: model.api,
		content: [], stopReason: "stop", timestamp: 0,
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	source.push({ type: "done", reason: "stop", message });
	delegates.chat.streamSimple.mockReturnValue(source);
	const result = await provider.streamSimple(model, normalizeContext({ messages: [] })).result();
	expect(result.usage.cost).toMatchObject({ magpiePricing: "unavailable" });
	expect(appendEntry).toHaveBeenCalledExactlyOnceWith("magpie-pricing", { pricing: "unavailable" });
});

it.each((["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const).flatMap((endpoint, index) =>
	(["group/foo", "bare-model"] as const).map(id => ({ endpoint, key: (["chat", "responses", "messages"] as const)[index], id })),
))("delegates both stream methods unchanged for $endpoint with $id", async ({ endpoint, key, id }) => {
	const model = parseModels({ data: [{ id, owned_by: "codex", native_endpoints: [endpoint] }] }, config.origin)[0];
	const provider = createMagpieProvider({});
	const context = normalizeContext({ messages: [] });
	const options = { apiKey: "secret", signal: new AbortController().signal, onPayload: vi.fn(), onResponse: vi.fn(), onProviderStreamEvent: vi.fn() };
	for (const method of ["stream", "streamSimple"] as const) {
		const event = { type: "text_delta", delta: "raw delegated event" };
		delegates[key][method].mockReturnValue((async function* () { yield event; })());
		const received = [];
		for await (const item of provider[method](model, context, options)) received.push(item);
		expect(received).toEqual([event]);
		expect(delegates[key][method]).toHaveBeenCalledWith(model, context, options);
		const delegatedModel = delegates[key][method].mock.lastCall![0];
		expect(delegatedModel.id).toBe(id);
	}
});

it.each(["stream", "streamSimple"] as const)("dispatches local Claude aliases through %s with recoverable selection IDs and physical provenance", async method => {
	const name = "claude-opus-5-5";
	const id = `claude1/${name}`;
	http({ data: [{ id, owned_by: "claude1", native_endpoints: ["/v1/messages"] }] });
	const provider = createMagpieProvider({});
	await provider.refreshModels!(refresh());
	const alias = provider.getModels().find(model => model.id === name)!;
	expect(alias).toBeDefined();
	// Exercise normalization after alias resolution for saved endpoint metadata as well.
	const selected = { ...alias, baseUrl: `${config.origin}/v1`, cost: { ...alias.cost, input: 7, output: 9 } };
	const context = normalizeContext({ messages: [] });
	const options = { apiKey: "secret" };
	const message: AssistantMessage = { role: "assistant", provider: "magpie", model: id, api: "anthropic-messages",
		content: [{ type: "thinking", thinking: "fixture reasoning", thinkingSignature: "signed-fixture" }, { type: "text", text: "Physical route response" }], stopReason: "stop", timestamp: 0,
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
			cost: { input: 0.007, output: 0.0009, cacheRead: 0, cacheWrite: 0, total: 0.0079 } } };
	const source = createAssistantMessageEventStream();
	source.push({ type: "start", partial: message });
	source.push({ type: "done", reason: "stop", message });
	delegates.messages[method].mockReturnValue(source);
	const stream = provider[method](selected, context, options);
	const result = await stream.result();
	expect(delegates.messages[method]).toHaveBeenLastCalledWith({ ...selected, id, baseUrl: config.origin }, context, options);
	expect(result).toMatchObject({ model: name, magpiePhysicalModel: id });
	expect(result.usage.cost).toMatchObject({ total: 0.0079, magpiePricing: "unavailable" });
	const events = [];
	for await (const event of stream) events.push(event);
	expect(events[0]).toMatchObject({ partial: { model: name, magpiePhysicalModel: id } });
	expect(events[1]).toMatchObject({ message: { model: name, magpiePhysicalModel: id } });
	expect(selected.id).toBe(name);
	const persisted = JSON.parse(JSON.stringify(result)) as AssistantMessage;
	const replay = normalizeContext({ messages: [persisted] });
	const nextSource = createAssistantMessageEventStream();
	nextSource.push({ type: "done", reason: "stop", message });
	delegates.messages[method].mockReturnValue(nextSource);
	await provider[method](selected, replay, options).result();
	const replayed = delegates.messages[method].mock.lastCall![1].messages.find((row: { role: string }) => row.role === "assistant");
	expect(replayed.model).toBe(id);
	expect(replayed.content).toEqual(message.content);
	expect(persisted.model).toBe(name);
});

it.each(["stream", "streamSimple"] as const)("rejects disappeared, changed-owner, ambiguous, and historically rebound aliases before %s", async method => {
	const name = "claude-opus-5-5";
	const original = { id: `claude1/${name}`, owned_by: "claude1", native_endpoints: ["/v1/messages"] };
	http({ data: [original] });
	const provider = createMagpieProvider({});
	await provider.refreshModels!(refresh());
	const saved = provider.getModels().find(model => model.id === name)!;
	for (const rows of [
		[{ ...original, id: `claude2/${name}`, owned_by: "claude2" }],
		[{ ...original, owned_by: "claude2" }],
		[original, { ...original, id: `claude2/${name}`, owned_by: "claude2" }],
	]) {
		http({ data: rows });
		await provider.refreshModels!(refresh());
		delegates.messages[method].mockClear();
		expect(() => provider[method](saved, normalizeContext({ messages: [] }))).toThrow(/Start a new session or select an explicit provider route/);
		expect(delegates.messages[method]).not.toHaveBeenCalled();
	}
	// Reloading can select the new short alias; normalized history still proves its previous source.
	http({ data: [{ ...original, id: `claude2/${name}`, owned_by: "claude2" }] });
	await provider.refreshModels!(refresh());
	const rebound = provider.getModels().find(model => model.id === name)!;
	const prior: AssistantMessage = { role: "assistant", provider: "magpie", model: original.id, api: "anthropic-messages",
		content: [], stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	expect(() => provider[method](rebound, normalizeContext({ messages: [prior] }))).toThrow(/Start a new session/);
	expect(delegates.messages[method]).not.toHaveBeenCalled();
});

it.each(["stream", "streamSimple"] as const)("keeps an actual advertised bare Claude wire ID unchanged through %s", async method => {
	const name = "claude-opus-5-5";
	const metadata = { owned_by: "claude1", native_endpoints: ["/v1/messages"] };
	http({ data: [{ ...metadata, id: `claude1/${name}` }, { ...metadata, id: name }] });
	const provider = createMagpieProvider({});
	await provider.refreshModels!(refresh());
	const bare = provider.getModels().find(model => model.id === name)!;
	delegates.messages[method].mockReturnValue((async function* () {})());
	const context = normalizeContext({ messages: [] });
	for await (const _event of provider[method](bare, context)) { /* Drain the wrapper. */ }
	expect(delegates.messages[method]).toHaveBeenLastCalledWith(bare, context, undefined);
	expect(delegates.messages[method].mock.lastCall![0].id).toBe(name);
});
