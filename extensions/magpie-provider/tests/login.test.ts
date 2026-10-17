import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore, type ApiKeyCredential, type AuthPrompt, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magpie, { createMagpieProvider } from "../index.ts";

const saved: ApiKeyCredential = { type: "api_key", key: "saved-secret", env: { MAGPIE_BASE_URL: "https://saved.example" } };
const catalog = (id = "old") => Response.json({ data: [{ id }] });
const ambient = { MAGPIE_BASE_URL: "https://ambient.example", MAGPIE_API_KEY: "ambient-secret" };
const authContext = { env: async () => undefined, fileExists: async () => false };
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "magpie-login-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("MAGPIE_BASE_URL", ambient.MAGPIE_BASE_URL);
	vi.stubEnv("MAGPIE_API_KEY", ambient.MAGPIE_API_KEY);
	vi.stubEnv("PI_OFFLINE", "0");
	vi.stubGlobal("fetch", vi.fn(async () => catalog()));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function setup(env: NodeJS.ProcessEnv = ambient) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("magpie", async () => saved);
	const models = createModels({ credentials, authContext });
	const provider = createMagpieProvider(env);
	models.setProvider(provider);
	await models.refresh();
	vi.mocked(fetch).mockClear();
	return { credentials, models, provider };
}
function interaction(url: string, key: string) {
	return { prompt: vi.fn<(prompt: AuthPrompt) => Promise<string>>().mockResolvedValueOnce(url).mockResolvedValueOnce(key), notify: vi.fn() };
}

describe("native api-key login", () => {
	it("validates then atomically stores URL/key without publishing before persistence", async () => {
		const { credentials, models, provider } = await setup();
		const previous = provider.getModels();
		const ui = interaction("https://new.example/v1/", "new-secret");
		const credential = await models.login("magpie", "api_key", ui);
		expect(credential).toEqual({ type: "api_key", key: "new-secret", env: { MAGPIE_BASE_URL: "https://new.example" } });
		expect(await credentials.read("magpie")).toEqual(credential);
		expect(provider.getModels()).toBe(previous);
		expect(ui.prompt.mock.calls[0][0]).toMatchObject({ type: "text", placeholder: "https://saved.example" });
		expect(ui.prompt.mock.calls[1][0]).toMatchObject({ type: "secret" });
		expect(JSON.stringify(ui.prompt.mock.calls)).not.toContain("saved-secret");
		expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ type: "progress" }));
		expect(fetch).toHaveBeenCalledWith("https://new.example/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer new-secret" }, redirect: "error" }));
		expect(await models.getAuth("magpie")).toMatchObject({ auth: { apiKey: "new-secret", baseUrl: "https://new.example/v1" }, env: { MAGPIE_BASE_URL: "https://new.example" } });
		await models.refresh({ allowNetwork: false });
		expect(provider.getModels()).toEqual([]);
	});
	it("accepts an authenticated empty catalog without changing refresh retention", async () => {
		const { models, provider } = await setup();
		const previous = provider.getModels();
		vi.mocked(fetch).mockResolvedValue(Response.json({ data: [] }));
		await models.login("magpie", "api_key", interaction("", "saved-secret"));
		expect((await models.refresh()).errors.has("magpie")).toBe(true);
		expect(provider.getModels()).toBe(previous);
	});
	it.each(["", "https://new.example"])("never reuses saved or ambient keys for remote login (%s)", async url => {
		const { models, credentials, provider } = await setup();
		const previous = provider.getModels();
		await expect(models.login("magpie", "api_key", interaction(url, ""))).rejects.toThrow("MAGPIE_API_KEY");
		expect(fetch).not.toHaveBeenCalled();
		expect(await credentials.read("magpie")).toEqual(saved);
		expect(provider.getModels()).toBe(previous);
	});
	it("allows blank local URL/key and never copies the ambient key", async () => {
		const provider = createMagpieProvider({ MAGPIE_API_KEY: "not-for-login" });
		const credential = await provider.auth.apiKey!.login!({ ...interaction("", ""), signal: new AbortController().signal });
		expect(credential).toEqual({ type: "api_key", key: "magpie-pi", env: { MAGPIE_BASE_URL: "http://127.0.0.1:3425" } });
	});
	it("leaves the old credential/catalog untouched on validation failure with safe errors", async () => {
		const { models, credentials, provider } = await setup();
		const previous = provider.getModels();
		vi.mocked(fetch).mockRejectedValue(new Error("new-secret"));
		await expect(models.login("magpie", "api_key", interaction("https://new.example", "new-secret"))).rejects.toThrow("Magpie model discovery failed");
		expect(await credentials.read("magpie")).toEqual(saved);
		expect(provider.getModels()).toBe(previous);
	});
	it("cancels pending discovery without replacing credentials or publishing", async () => {
		const { models, credentials, provider } = await setup();
		const previous = provider.getModels();
		const controller = new AbortController();
		vi.mocked(fetch).mockImplementation(async (_url, init) => {
			controller.abort();
			init?.signal?.throwIfAborted();
			return catalog();
		});
		await expect(models.login("magpie", "api_key", { ...interaction("https://new.example", "new-key"), signal: controller.signal })).rejects.toThrow();
		expect(await credentials.read("magpie")).toEqual(saved);
		expect(provider.getModels()).toBe(previous);
	});
	it.each([0, 1])("checks cancellation after ignored prompt abort at step %s", async step => {
		const { models, credentials, provider } = await setup();
		const previous = provider.getModels();
		const controller = new AbortController();
		let calls = 0;
		const prompt = vi.fn(async () => { if (calls++ === step) controller.abort(); return "https://new.example"; });
		await expect(models.login("magpie", "api_key", { prompt, notify: vi.fn(), signal: controller.signal })).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
		expect(await credentials.read("magpie")).toEqual(saved);
		expect(provider.getModels()).toBe(previous);
		expect(prompt).toHaveBeenCalledTimes(step + 1);
	});
});

describe("connection-scoped refresh and logout", () => {
	it("uses saved URL/key over ambient; missing saved URL falls back per field", async () => {
		const { models, credentials } = await setup();
		await models.refresh();
		expect(fetch).toHaveBeenLastCalledWith("https://saved.example/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer saved-secret" } }));
		await credentials.modify("magpie", async () => ({ type: "api_key", key: "legacy-key" }));
		await models.refresh();
		expect(fetch).toHaveBeenLastCalledWith("https://ambient.example/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer legacy-key" } }));
	});
	it.each([true, false])("logout clears old catalog even when network=%s and new endpoint fails", async allowNetwork => {
		const { models, provider } = await setup();
		await models.logout("magpie");
		vi.mocked(fetch).mockRejectedValue(new Error("offline"));
		await models.refresh({ allowNetwork });
		expect(provider.getModels()).toEqual([]);
		expect(await models.getAuth("magpie")).toMatchObject({ auth: { apiKey: "ambient-secret", baseUrl: "https://ambient.example/v1" } });
		if (!allowNetwork) expect(fetch).not.toHaveBeenCalled();
	});
	it("clears a catalog after key rotation even if discovery fails", async () => {
		const { models, provider, credentials } = await setup();
		await credentials.modify("magpie", async () => ({ ...saved, key: "rotated" }));
		vi.mocked(fetch).mockRejectedValue(new Error("offline"));
		await models.refresh();
		expect(provider.getModels()).toEqual([]);
	});
	it("logout restores local defaults rather than retaining saved remote credentials", async () => {
		const { models, provider } = await setup({});
		await models.logout("magpie");
		await models.refresh({ allowNetwork: false });
		expect(provider.getModels()).toEqual([]);
		expect(await models.getAuth("magpie")).toMatchObject({ auth: { apiKey: "magpie-pi", baseUrl: "http://127.0.0.1:3425/v1" } });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not carry the resolved local dummy to a saved remote URL missing a key", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("magpie", async () => ({ type: "api_key", env: saved.env }));
		const models = createModels({ credentials, authContext });
		models.setProvider(createMagpieProvider({}));
		expect(await models.getAuth("magpie")).toBeUndefined();
		await models.refresh();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("registers remote without key but neither resolves auth nor sends discovery", async () => {
		const provider = createMagpieProvider({ MAGPIE_BASE_URL: "https://unconfigured.example" });
		const models = createModels({ authContext }); models.setProvider(provider);
		expect(await models.getAuth("magpie")).toBeUndefined();
		await models.refresh();
		expect(fetch).not.toHaveBeenCalled();
	});
});

it.each([false, true])("startup reads only the saved connection using public helper, offline=%s", async offline => {
	const path = join(directory, "auth.json");
	const contents = JSON.stringify({ magpie: saved, unrelated: { type: "api_key", key: "!must-not-execute" } });
	writeFileSync(path, contents);
	vi.stubEnv("PI_OFFLINE", offline ? "1" : "0");
	const registerProvider = vi.fn();
	await magpie({ registerProvider, on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);
	const provider = registerProvider.mock.calls[0][0] as Provider;
	expect(readFileSync(path, "utf8")).toBe(contents);
	if (offline) expect(fetch).not.toHaveBeenCalled();
	else {
		expect(fetch).toHaveBeenCalledWith("https://saved.example/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer saved-secret" } }));
		expect(provider.getModels()[0].id).toBe("old");
	}
	const models = createModels({ authContext }); models.setProvider(provider);
	await models.refresh({ allowNetwork: false });
	expect(provider.getModels()).toEqual([]);
	expect(await models.getAuth("magpie")).toMatchObject({ auth: { apiKey: "ambient-secret", baseUrl: "https://ambient.example/v1" } });
});

it("startup accepts absent credentials but surfaces malformed saved URLs", async () => {
	const pi = { registerProvider: vi.fn(), on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI;
	await magpie(pi);
	writeFileSync(join(directory, "auth.json"), JSON.stringify({ magpie: { ...saved, env: { MAGPIE_BASE_URL: "https://secret@host/path" } } }));
	await expect(magpie(pi)).rejects.toThrow("MAGPIE_BASE_URL");
});
