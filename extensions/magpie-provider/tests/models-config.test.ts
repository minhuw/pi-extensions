import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore, normalizeContext, type ModelsPublication } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magpie, { createMagpieProvider, parseModels } from "../index.ts";
import { assertNativeCatalog } from "../models-config.ts";

let directory: string;
let path: string;
const signal = () => new AbortController().signal;
const publish = async ({ update }: ModelsPublication) => { update?.(); return true; };
const writeConfig = (magpie: unknown) => writeFileSync(path, JSON.stringify({ providers: { magpie } }));
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "magpie-config-"));
	path = join(directory, "models.json");
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:3425");
	vi.stubEnv("MAGPIE_API_KEY", "");
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "chat" }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function runtime() {
	return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: path,
		modelsStorePath: join(directory, "catalog.json"), refreshOnCreate: false });
}

async function register(models: ModelRuntime, provider: ReturnType<typeof createMagpieProvider>) {
	// Registration starts a fire-and-forget offline refresh; await it before another refresh.
	const refresh = vi.spyOn(models, "refresh");
	try {
		models.registerNativeProvider(provider);
		await refresh.mock.results[0].value;
	} finally { refresh.mockRestore(); }
}

it.each(["stream", "streamSimple"] as const)("blocks a models.json Anthropic-only catalog with empty native discovery before %s can fetch", async method => {
	const model = parseModels({ data: [{ id: "claude-sonnet-4-6", native_endpoints: ["/v1/messages"] }] }, "https://gateway.example")[0];
	writeConfig({ apiKey: "configured-secret", models: [model] });
	const original = readFileSync(path, "utf8");
	const models = await runtime();
	const provider = createMagpieProvider({});
	await register(models, provider);
	expect(provider.getModels()).toEqual([]);
	const refreshed = await models.refresh({ providers: ["magpie"], allowNetwork: false });
	expect(refreshed.errors.get("magpie")?.message).toContain("Remove providers.magpie");
	const selected = models.getModel("magpie", model.id)!;
	expect(selected).toBeDefined();
	const result = await models[method](selected, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] })).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Remove providers.magpie");
	expect(result.errorMessage).not.toContain("configured-secret");
	expect(fetch).not.toHaveBeenCalled();
	expect(readFileSync(path, "utf8")).toBe(original);
});

it.each(["stream", "streamSimple"] as const)("blocks metadata-only composition for a stale selected Anthropic model before %s", async method => {
	vi.mocked(fetch).mockImplementation(async () => Response.json({ data: [{ id: "claude-sonnet-4-6", native_endpoints: ["/v1/messages"] }] }));
	const models = await runtime();
	const provider = createMagpieProvider({});
	await register(models, provider);
	await models.refresh({ providers: ["magpie"] });
	const selected = models.getModel("magpie", "claude-sonnet-4-6")!;
	expect(selected?.api).toBe("anthropic-messages");
	await models.setRuntimeApiKey("magpie", "changed-key");
	vi.mocked(fetch).mockRejectedValue(new Error("gateway unavailable"));
	expect((await models.refresh({ providers: ["magpie"] })).errors.has("magpie")).toBe(true);
	expect(provider.getModels()).toEqual([]);
	writeConfig({ modelOverrides: { "claude-sonnet-4-6": { name: "Custom" } } });
	const original = readFileSync(path, "utf8");
	await models.refresh({ providers: ["magpie"], allowNetwork: false });
	vi.mocked(fetch).mockClear();
	const result = await models[method](selected, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] })).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Remove providers.magpie");
	expect(fetch).not.toHaveBeenCalled();
	expect(readFileSync(path, "utf8")).toBe(original);
});

it("rejects live additions before login, auth, refresh or factory startup", async () => {
	const models = await runtime();
	const provider = createMagpieProvider({});
	await register(models, provider);
	await models.refresh({ providers: ["magpie"] });
	vi.mocked(fetch).mockClear();
	writeConfig({ api: "anthropic-messages", models: [{ id: "extra", baseUrl: "https://gateway.example" }] });
	const result = await models.refresh({ providers: ["magpie"] });
	expect(result.errors.get("magpie")?.message).toContain("one configuration owner");
	const ui = { prompt: vi.fn(), notify: vi.fn(), signal: signal() };
	await expect(provider.auth.apiKey!.login!(ui)).rejects.toThrow("Remove providers.magpie");
	await expect(provider.auth.apiKey!.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: signal() })).rejects.toThrow("Remove providers.magpie");
	const pi = { registerProvider: vi.fn(), on: vi.fn(), registerCommand: vi.fn() };
	await expect(magpie(pi as unknown as ExtensionAPI)).rejects.toThrow("Remove providers.magpie");
	expect(pi.registerProvider).not.toHaveBeenCalled();
	expect(ui.prompt).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it("rechecks configuration before discovery if adapter sync runs during login prompts", async () => {
	const provider = createMagpieProvider({});
	const prompt = vi.fn(async () => {
		writeConfig({ models: [{ id: "extra" }] });
		return "";
	});
	await expect(provider.auth.apiKey!.login!({ prompt, notify: vi.fn(), signal: signal() })).rejects.toThrow("Remove providers.magpie");
	expect(fetch).not.toHaveBeenCalled();
});

it("matches Pi's BOM, line comments and trailing comma parsing without touching strings", () => {
	const contents = '\uFEFF{ // note\n "providers": { "unrelated": { "apiKey": "https://key.example/a,}\\\"//", "models": [], "modelOverrides": { "chat": { "name": "Custom", }, }, }, }, }';
	writeFileSync(path, contents);
	expect(assertNativeCatalog).not.toThrow();
	writeFileSync(path, contents.replace('"unrelated"', '"magpie"'));
	expect(assertNativeCatalog).toThrow("Remove providers.magpie");
});

it.each([{}, null, false, 0, "", [], { api: "anthropic-messages" }, { models: [] },
	{ models: [{ id: "secret" }] }, { modelOverrides: { chat: { name: "Custom" } } }, { apiKey: "secret" },
])("rejects every own providers.magpie value: %j", value => {
	writeConfig(value);
	expect(assertNativeCatalog).toThrow("Remove providers.magpie");
});

it("fails safely on malformed or unreadable config and allows missing files", () => {
	expect(assertNativeCatalog).not.toThrow();
	writeFileSync(path, '{"secret": "do-not-expose"');
	try { assertNativeCatalog(); throw new Error("expected failure"); }
	catch (error) {
		expect((error as Error).message).toContain("Magpie cannot safely read models.json");
		expect((error as Error).message).not.toContain("do-not-expose");
	}
	rmSync(path);
	// Reading a directory fails without relying on chmod under privileged test runners.
	mkdirSync(path);
	expect(assertNativeCatalog).toThrow("Magpie cannot safely read models.json");
	rmSync(path, { recursive: true });
	writeFileSync(path, "/* unsupported by Pi */ {}");
	expect(assertNativeCatalog).toThrow("valid JSON");
});

it("retains effective-key catalog across raw-absent offline phases and network failures", async () => {
	const provider = createMagpieProvider({});
	const offline = { allowNetwork: false, signal: signal(), publish };
	const network = { allowNetwork: true, signal: signal(), publish, credential: { type: "api_key" as const, key: "effective-secret" } };
	await provider.refreshModels!(offline);
	await provider.refreshModels!(network);
	expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:3425/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer effective-secret" } }));
	const previous = provider.getModels();
	expect(previous).toHaveLength(1);
	vi.mocked(fetch).mockRejectedValue(new Error("offline"));
	await provider.refreshModels!(offline);
	expect(provider.getModels()).toBe(previous);
	await expect(provider.refreshModels!(network)).rejects.toThrow("Magpie model discovery failed");
	expect(provider.getModels()).toBe(previous);
	vi.mocked(fetch).mockClear();
	await provider.refreshModels!(offline);
	expect(provider.getModels()).toBe(previous);
	expect(fetch).not.toHaveBeenCalled();
	await expect(provider.refreshModels!({ ...network, credential: { type: "api_key", key: "changed-key" } })).rejects.toThrow();
	expect(provider.getModels()).toEqual([]);
});

it("does not mutate raw provenance when generation-checked publication refuses it", async () => {
	const provider = createMagpieProvider({});
	await provider.refreshModels!({ allowNetwork: false, signal: signal(), publish });
	await provider.refreshModels!({ allowNetwork: true, signal: signal(), publish });
	const previous = provider.getModels();
	await provider.refreshModels!({ allowNetwork: false, credential: { type: "api_key", key: "rejected-key" }, signal: signal(), publish: async () => false });
	await provider.refreshModels!({ allowNetwork: false, signal: signal(), publish });
	expect(provider.getModels()).toBe(previous);
});

it("raw credential change clears even when the effective connection values are unchanged", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const provider = createMagpieProvider({});
	models.setProvider(provider);
	await models.refresh();
	await credentials.modify("magpie", async () => ({ type: "api_key", key: "magpie-pi" }));
	await models.refresh({ allowNetwork: false });
	expect(provider.getModels()).toEqual([]);
	await models.refresh();
	await models.logout("magpie");
	await models.refresh({ allowNetwork: false });
	expect(provider.getModels()).toEqual([]);
});
