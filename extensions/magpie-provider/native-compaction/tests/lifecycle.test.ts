import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { registerNativeCompaction } from "../lifecycle.ts";
import { modelKey, NATIVE_COMPACTION_KIND, NATIVE_COMPACTION_VERSION } from "../native-compaction.ts";
import type { NativeCompactionConfig } from "../types.ts";

const model = (provider: string): Model<any> => ({
	provider, api: "openai-responses", id: "test-model", name: "Test",
	baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
});
const opaque = { type: "compaction", encrypted_content: "sealed" };

function registration(provider: string, overrides: Partial<NativeCompactionConfig> = {}, brokenConfig = false) {
	const handlers: Record<string, (event: any, ctx: ExtensionContext) => any> = {};
	const commands: Record<string, any> = {};
	const config: NativeCompactionConfig = {
		enabled: true, providerId: provider, apiId: "openai-responses", models: ["test-model"],
		fallbackToBuiltin: true, ...overrides,
	};
	// Separate API objects match Pi's per-extension registration contract.
	const pi = {
		on: (name: string, handler: any) => { handlers[name] = handler; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	registerNativeCompaction(pi, {
		loadConfig: () => { if (brokenConfig) throw new Error("bad config"); return config; },
		ownsProvider: (id, config) => id === config.providerId,
		command: `${provider}-compact`, label: provider,
	});
	return { handlers, commands };
}

function fixture(currentProvider: string, checkpointProvider?: string, malformed = false) {
	const session = SessionManager.inMemory();
	const firstId = session.appendMessage({ role: "user", content: "task", timestamp: 0 });
	if (checkpointProvider) session.appendCompaction("marker", firstId, 100, {
		kind: NATIVE_COMPACTION_KIND, version: NATIVE_COMPACTION_VERSION, endpoint: "responses",
		modelKey: modelKey(model(checkpointProvider)), replacementHistory: malformed ? [] : [opaque],
	});
	const abort = vi.fn();
	const notify = vi.fn();
	const auth = vi.fn(async () => ({ ok: true, apiKey: "secret", headers: {} }));
	const ctx = {
		model: model(currentProvider), sessionManager: session, abort, hasUI: true, ui: { notify },
		modelRegistry: { getApiKeyAndHeaders: auth },
	} as unknown as ExtensionContext;
	const event = {
		type: "session_before_compact", branchEntries: session.getBranch(), reason: "manual", willRetry: false,
		preparation: { firstKeptEntryId: firstId, tokensBefore: 100 }, signal: new AbortController().signal,
	};
	const payload = { model: "test-model", input: ["stale"], messages: ["stale"], previous_response_id: "stale" };
	return { ctx, event, payload, abort, notify, auth };
}

afterEach(() => vi.unstubAllGlobals());

describe("provider-scoped lifecycle", () => {
	it.each(["alpha", "beta"])("only %s acts on its healthy checkpoint with two registrations", async (owner) => {
		const f = fixture(owner, owner);
		const fetchMock = vi.fn(async () => Response.json({ output: [opaque] }));
		vi.stubGlobal("fetch", fetchMock);
		for (const provider of ["alpha", "beta"]) {
			const { handlers } = registration(provider);
			const replay = handlers.before_provider_request!({ payload: f.payload }, f.ctx);
			const context = handlers.context!({ messages: [{ role: "compactionSummary" }, { role: "user" }] }, f.ctx);
			const compact = await handlers.session_before_compact!(f.event, f.ctx);
			if (provider === owner) {
				expect(replay).toEqual({ model: "test-model", input: [opaque] });
				expect(context).toEqual({ messages: [{ role: "user" }] });
				expect(compact.compaction.details.modelKey).toBe(modelKey(model(owner)));
				expect(compact.compaction.summary).toContain(owner);
			} else {
				expect(replay).toBeUndefined();
				expect(context).toBeUndefined();
				expect(compact).toBeUndefined();
			}
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(f.abort).not.toHaveBeenCalled();
	});

	it.each([{ enabled: false }, { models: [] }])("replays existing checkpoints despite %j, but creates no new ones", async (config) => {
		const { handlers } = registration("alpha", config);
		const f = fixture("alpha", "alpha");
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([opaque]);
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
		const fresh = fixture("alpha");
		expect(await handlers.session_before_compact!(fresh.event, fresh.ctx)).toBeUndefined();
	});

	it.each([ ["alpha", "beta"], ["beta", "alpha"] ])("blocks model/checkpoint mismatch %s/%s", async (current, checkpoint) => {
		const { handlers } = registration("alpha");
		const f = fixture(current, checkpoint);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx)).toEqual({ model: "test-model", input: [] });
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it("fails closed on malformed recognized checkpoints in the current provider scope", async () => {
		const { handlers } = registration("alpha");
		const f = fixture("alpha", "alpha", true);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([]);
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it.each([false, true])("guards foreign history after its owning extension is removed (malformed=%s)", async malformed => {
		const { handlers } = registration("alpha");
		const f = fixture("third-party", "removed-provider", malformed);
		expect(handlers.before_provider_request!({ payload: f.payload }, f.ctx).input).toEqual([]);
		expect(f.abort).toHaveBeenCalledOnce();
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it("cancels rather than throwing on configuration errors", async () => {
		const { handlers } = registration("alpha", {}, true);
		const f = fixture("alpha");
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
		expect(f.auth).not.toHaveBeenCalled();
	});

	it.each([
		{ checkpoint: undefined, fallbackToBuiltin: true, expected: undefined },
		{ checkpoint: undefined, fallbackToBuiltin: false, expected: { cancel: true } },
		{ checkpoint: "alpha", fallbackToBuiltin: true, expected: { cancel: true } },
	])("limits failure fallback: %j", async ({ checkpoint, fallbackToBuiltin, expected }) => {
		const { handlers } = registration("alpha", { fallbackToBuiltin });
		const f = fixture("alpha", checkpoint);
		f.auth.mockRejectedValue(new Error("authentication failed"));
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual(expected);
	});

	it("cancels an aborted compaction without falling back", async () => {
		const { handlers } = registration("alpha");
		const f = fixture("alpha");
		f.event.signal = AbortSignal.abort();
		f.auth.mockRejectedValue(new Error("aborted"));
		expect(await handlers.session_before_compact!(f.event, f.ctx)).toEqual({ cancel: true });
	});

	it("uses the configured command and retains argument validation", async () => {
		const { commands } = registration("alpha");
		const f = fixture("alpha");
		await commands["alpha-compact"].handler("unexpected", f.ctx);
		expect(f.notify).toHaveBeenLastCalledWith("Usage: /alpha-compact", "error");
		await commands["alpha-compact"].handler("", f.ctx);
		expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Enabled for alpha/test-model"), "info");
	});
});
