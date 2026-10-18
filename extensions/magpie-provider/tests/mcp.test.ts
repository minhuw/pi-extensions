import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, type ApiKeyCredential, type AuthPrompt, type ModelsPublication, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magpie, { createMagpieProvider } from "../index.ts";
import { MAGPIE_SEARCH_SERVER, magpieSearchConfig } from "../mcp.ts";

const saved: ApiKeyCredential = { type: "api_key", key: "saved-key", env: { MAGPIE_BASE_URL: "https://saved.example" } };
const ambient = { MAGPIE_BASE_URL: "https://ambient.example", MAGPIE_API_KEY: "ambient-key" };
const refresh = (overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
	allowNetwork: false, signal: new AbortController().signal,
	publish: async ({ update }: ModelsPublication) => { update?.(); return true; }, ...overrides,
});
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "magpie-mcp-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("MAGPIE_BASE_URL", ambient.MAGPIE_BASE_URL);
	vi.stubEnv("MAGPIE_API_KEY", ambient.MAGPIE_API_KEY);
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "test" }] })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it("builds an allowlisted, origin-bound literal header with native template escaping", () => {
	const apiKey = "!never-run ${SECRET} $KEY $$ $! trailing$";
	const config = magpieSearchConfig({ origin: "https://saved.example", apiKey });
	expect(config).toEqual({
		url: "https://saved.example/mcp/magpie/web-search",
		headers: { Authorization: "Bearer !never-run $${SECRET} $$KEY $$$$ $$! trailing$$" },
		exposure: "hidden", toolExposure: { web_search: "direct", web_fetch: "direct" },
	});
	expect(config).not.toHaveProperty("auth");
});

it.each([true, false])("registers saved startup connection exactly once, offline=%s", async offline => {
	writeFileSync(join(directory, "auth.json"), JSON.stringify({ magpie: saved }));
	vi.stubEnv("PI_OFFLINE", offline ? "1" : "0");
	const registerMcpServer = vi.fn();
	const unregisterMcpServer = vi.fn();
	await magpie({ registerProvider: vi.fn(), registerMcpServer, unregisterMcpServer, on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);
	expect(registerMcpServer).toHaveBeenCalledExactlyOnceWith(MAGPIE_SEARCH_SERVER, magpieSearchConfig({ origin: "https://saved.example", apiKey: "saved-key" }));
	expect(unregisterMcpServer).not.toHaveBeenCalled();
	expect(readdirSync(directory)).toEqual(["auth.json"]);
	expect(fetch).toHaveBeenCalledTimes(offline ? 0 : 1);
});

it.each([{}, ambient])("does not publish MCP for ambient/default auth only: %j", async env => {
	const publish = vi.fn();
	const provider = createMagpieProvider(env, publish);
	await provider.refreshModels!(refresh());
	await provider.refreshModels!(refresh({ allowNetwork: true }));
	expect(provider.getModels()).toHaveLength(1);
	expect(publish).not.toHaveBeenCalled();
});

it.each([true, false])("publishes connection changes before discovery, network=%s", async allowNetwork => {
	const publish = vi.fn();
	const provider = createMagpieProvider(ambient, publish);
	await provider.refreshModels!(refresh({ credential: saved }));
	await provider.refreshModels!(refresh({ credential: saved, allowNetwork: true }));
	const previous = provider.getModels();
	await provider.refreshModels!(refresh({ credential: { ...saved, env: { ...saved.env } } }));
	expect(publish).toHaveBeenCalledTimes(1);
	expect(provider.getModels()).toBe(previous);
	const rotated = { ...saved, key: "rotated", env: { MAGPIE_BASE_URL: "https://new.example" } };
	vi.mocked(fetch).mockRejectedValue(new Error("secret failure"));
	const pending = provider.refreshModels!(refresh({ credential: rotated, allowNetwork }));
	if (allowNetwork) await expect(pending).rejects.toThrow("Magpie model discovery failed");
	else await pending;
	expect(provider.getModels()).toEqual([]);
	expect(publish.mock.calls).toEqual([[{ origin: "https://saved.example", apiKey: "saved-key" }], [{ origin: "https://new.example", apiKey: "rotated" }]]);
	await provider.refreshModels!(refresh());
	expect(publish).toHaveBeenLastCalledWith(undefined);
	expect(publish).toHaveBeenCalledTimes(3);
	await provider.refreshModels!(refresh());
	expect(publish).toHaveBeenCalledTimes(3);
});

it("does not publish or clear models for rejected generations, and retries the accepted identity", async () => {
	const publish = vi.fn();
	const provider = createMagpieProvider({}, publish);
	await provider.refreshModels!(refresh({ credential: saved }));
	await provider.refreshModels!(refresh({ credential: saved, allowNetwork: true }));
	const previous = provider.getModels();
	const rotated = { ...saved, key: "new" };
	for (const allowNetwork of [false, true]) {
		await provider.refreshModels!(refresh({ credential: rotated, allowNetwork, publish: async () => false }));
		await provider.refreshModels!(refresh({ allowNetwork, publish: async () => false }));
	}
	expect(publish).toHaveBeenCalledTimes(1);
	expect(provider.getModels()).toBe(previous);
	await provider.refreshModels!(refresh({ credential: rotated }));
	expect(publish).toHaveBeenLastCalledWith({ origin: "https://saved.example", apiKey: "new" });
});

it("unregisters when the effective saved connection lacks a key", async () => {
	const publish = vi.fn();
	const provider = createMagpieProvider({}, publish);
	await provider.refreshModels!(refresh({ credential: saved }));
	await provider.refreshModels!(refresh({ credential: { type: "api_key", env: saved.env } }));
	expect(publish.mock.calls).toEqual([[{ origin: "https://saved.example", apiKey: "saved-key" }], [undefined]]);
});

async function runtimeSetup() {
	const credentials = new InMemoryCredentialStore();
	const publish = vi.fn();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	// Registration schedules an offline refresh; wait before testing credential operations.
	const refreshSpy = vi.spyOn(runtime, "refresh");
	runtime.registerNativeProvider(createMagpieProvider(ambient, publish));
	await refreshSpy.mock.results[0].value;
	refreshSpy.mockRestore();
	const interaction = () => ({ prompt: vi.fn<(prompt: AuthPrompt) => Promise<string>>().mockResolvedValueOnce("https://login.example/v1").mockResolvedValueOnce("login-key"), notify: vi.fn() });
	return { credentials, publish, runtime, interaction };
}

it("native ModelRuntime login publishes only after persistence; logout removes despite ambient auth", async () => {
	const { credentials, publish, runtime, interaction } = await runtimeSetup();
	const original = credentials.modify.bind(credentials);
	vi.spyOn(credentials, "modify").mockImplementation(async (...args) => {
		expect(publish).not.toHaveBeenCalled();
		const result = await original(...args);
		expect(publish).not.toHaveBeenCalled();
		return result;
	});
	await runtime.login("magpie", "api_key", interaction());
	expect(publish).toHaveBeenCalledExactlyOnceWith({ origin: "https://login.example", apiKey: "login-key" });
	expect(await credentials.read("magpie")).toMatchObject({ key: "login-key" });
	expect(fetch).toHaveBeenCalledTimes(1); // Login validation only: synchronization is offline.
	await runtime.refresh({ providers: ["magpie"], allowNetwork: true });
	expect(publish).toHaveBeenCalledTimes(1);
	await runtime.logout("magpie");
	expect(publish).toHaveBeenLastCalledWith(undefined);
	expect(await runtime.getAuth("magpie")).toMatchObject({ auth: { apiKey: "ambient-key" } });
	await runtime.refresh({ providers: ["magpie"], allowNetwork: true });
	expect(publish).toHaveBeenCalledTimes(2);
	expect(publish).toHaveBeenLastCalledWith(undefined);
});

it.each(["validation", "cancelled", "persistence"])("native ModelRuntime %s failure never publishes MCP", async failure => {
	const { credentials, publish, runtime, interaction } = await runtimeSetup();
	const controller = new AbortController();
	if (failure === "validation") vi.mocked(fetch).mockRejectedValue(new Error("private"));
	if (failure === "cancelled") controller.abort();
	if (failure === "persistence") vi.spyOn(credentials, "modify").mockRejectedValue(new Error("storage unavailable"));
	await expect(runtime.login("magpie", "api_key", { ...interaction(), signal: controller.signal })).rejects.toThrow();
	expect(await credentials.read("magpie")).toBeUndefined();
	expect(publish).not.toHaveBeenCalled();
});

it("native ModelRuntime online refresh never enables MCP for ambient-only auth", async () => {
	const { runtime, publish } = await runtimeSetup();
	for (let i = 0; i < 2; i++) {
		await runtime.refresh({ providers: ["magpie"], allowNetwork: true });
		expect(runtime.getModels("magpie")).toHaveLength(1);
		expect(publish).not.toHaveBeenCalled();
	}
});

it.each(["private\nkey", "private\rkey", "private\0key", "private🔑"])("sanitizes invalid saved header %j", apiKey => {
	expect(() => magpieSearchConfig({ origin: "https://saved.example", apiKey })).toThrow(
		"Magpie MCP authorization header is invalid; check the saved API key.",
	);
	try { magpieSearchConfig({ origin: "https://saved.example", apiKey }); }
	catch (error) {
		expect(String(error)).not.toContain("private");
		expect(error).not.toHaveProperty("cause");
	}
});
