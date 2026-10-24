import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import magpie from "../index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "magpie-refresh-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:3425");
	vi.stubEnv("MAGPIE_API_KEY", "");
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "first" }] })));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function setup(credentials = new InMemoryCredentialStore(), getSettings = () => ({} as { enabledModels?: string[] })) {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
		modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
	const commands = new Map<string, Command>();
	const refresh = vi.spyOn(runtime, "refresh");
	await magpie({
		registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
		registerMcpServer: vi.fn(), unregisterMcpServer: vi.fn(), on: vi.fn(), getSettings,
	} as unknown as ExtensionAPI);
	// Native registration schedules an offline refresh; finish it before invoking the command.
	await refresh.mock.results[0].value;
	refresh.mockClear();
	const registry = new ModelRegistry(runtime);
	const notify = vi.fn();
	const ctx = { modelRegistry: registry, ui: { notify } } as unknown as ExtensionCommandContext;
	const command = commands.get("magpie-refresh")!;
	expect(command).toBeDefined();
	return { runtime, registry, refresh, notify, ctx, run: () => command.handler("", ctx) };
}

it("refreshes only Magpie over the network in an offline session and updates the registry immediately", async () => {
	const { registry, refresh, notify, run } = await setup();
	expect(fetch).not.toHaveBeenCalled();
	await run();
	expect(refresh).toHaveBeenCalledExactlyOnceWith({ providers: ["magpie"], allowNetwork: true, force: true, signal: undefined });
	expect(fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:3425/v1/models", expect.objectContaining({
		headers: { Authorization: "Bearer magpie-pi" },
	}));
	expect(registry.find("magpie", "first")).toBeDefined();
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 1 model.", "info");

	vi.mocked(fetch).mockResolvedValue(Response.json({ data: [{ id: "second" }, { id: "third" }] }));
	await run();
	expect(registry.find("magpie", "first")).toBeUndefined();
	expect(registry.find("magpie", "second")).toBeDefined();
	expect(registry.find("magpie", "third")).toBeDefined();
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 2 models.", "info");
});

it("counts visible selections while retaining duplicate routes in the full registry across refreshes", async () => {
	vi.mocked(fetch).mockResolvedValue(Response.json({ data: [
		{ id: "codex/gpt-6-astra", owned_by: "codex", native_endpoints: ["/v1/responses"] },
		{ id: "gpt-6-astra", owned_by: "codex", native_endpoints: ["/v1/responses"] },
		{ id: "contabo/claude/claude-opus-5-5", owned_by: "contabo", native_endpoints: ["/v1/messages"] },
		{ id: "claude/claude-opus-5-5", owned_by: "contabo", native_endpoints: ["/v1/messages"] },
	] }));
	const { runtime, registry, notify, run } = await setup();
	await run();
	const rawMagpie = () => registry.getAll().filter(model => model.provider === "magpie");
	const visibleMagpie = () => runtime.getAvailableSnapshot().filter(model => model.provider === "magpie");
	expect(rawMagpie()).toHaveLength(5);
	expect(registry.find("magpie", "codex/gpt-6-astra")).toBeDefined();
	expect(registry.find("magpie", "contabo/claude/claude-opus-5-5")).toBeDefined();
	expect(visibleMagpie().map(model => model.id)).toEqual(["gpt-6-astra", "claude-opus-5-5"]);
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 2 models.", "info");

	vi.mocked(fetch).mockResolvedValue(Response.json({ data: [{ id: "vendor/next", owned_by: "vendor" }, { id: "next", owned_by: "vendor" }] }));
	await run();
	expect(rawMagpie()).toHaveLength(2);
	expect(registry.find("magpie", "vendor/next")).toBeDefined();
	expect(registry.find("magpie", "codex/gpt-6-astra")).toBeUndefined();
	expect(visibleMagpie().map(model => model.id)).toEqual(["next"]);
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 1 model.", "info");

	vi.mocked(fetch).mockRejectedValue(new Error("fixture offline"));
	await run();
	expect(rawMagpie()).toHaveLength(2);
	expect(registry.find("magpie", "vendor/next")).toBeDefined();
	expect(visibleMagpie().map(model => model.id)).toEqual(["next"]);
	expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Magpie model refresh failed"), "error");
});

it("keeps scoped qualified routes available and restores short choices when the scope is cleared", async () => {
	vi.mocked(fetch).mockImplementation(async () => Response.json({ data: [
		{ id: "codex/gpt-6-astra", owned_by: "codex", native_endpoints: ["/v1/responses"] },
		{ id: "gpt-6-astra", owned_by: "codex", native_endpoints: ["/v1/responses"] },
	] }));
	let enabledModels = ["magpie/codex/gpt-6-astra:high"];
	const { runtime, notify, run } = await setup(new InMemoryCredentialStore(), () => ({ enabledModels }));
	await run();
	expect(runtime.getAvailableSnapshot().map(model => model.id)).toEqual(["codex/gpt-6-astra", "gpt-6-astra"]);
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 2 models.", "info");
	enabledModels = [];
	await run();
	expect(runtime.getAvailableSnapshot().map(model => model.id)).toEqual(["gpt-6-astra"]);
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 1 model.", "info");
});

it("uses Pi's current credentials and gateway instead of ambient configuration", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("magpie", async () => ({ type: "api_key", key: "saved-secret", env: { MAGPIE_BASE_URL: "https://saved.example" } }));
	const { runtime, registry, notify, run } = await setup(credentials);
	await run();
	expect(fetch).toHaveBeenLastCalledWith("https://saved.example/v1/models", expect.objectContaining({
		headers: { Authorization: "Bearer saved-secret" },
	}));

	// A runtime key replaces the stored credential, including its provider-scoped URL.
	await runtime.setRuntimeApiKey("magpie", "runtime-secret");
	await run();
	expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:3425/v1/models", expect.objectContaining({
		headers: { Authorization: "Bearer runtime-secret" },
	}));
	expect(registry.find("magpie", "first")).toBeDefined();
	expect(notify).toHaveBeenLastCalledWith("Magpie model list refreshed: 1 model.", "info");
});

it("reports discovery failures without leaking errors and retains the same-connection catalog", async () => {
	const { registry, notify, run } = await setup();
	await run();
	vi.mocked(fetch).mockRejectedValue(new Error("SECRET response body"));
	await run();
	expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Magpie model refresh failed"), "error");
	expect(JSON.stringify(notify.mock.calls)).not.toContain("SECRET");
	expect(registry.find("magpie", "first")).toBeDefined();
});

it("reports a cancelled refresh without claiming success", async () => {
	const { ctx, notify, refresh, run } = await setup();
	const controller = new AbortController();
	controller.abort();
	ctx.signal = controller.signal;
	await run();
	expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
	expect(fetch).not.toHaveBeenCalled();
	expect(notify).toHaveBeenCalledExactlyOnceWith("Magpie model refresh cancelled.", "warning");
});

it("directs an unconfigured remote gateway to login", async () => {
	vi.stubEnv("MAGPIE_BASE_URL", "https://remote.example");
	const { notify, run } = await setup();
	await run();
	expect(fetch).not.toHaveBeenCalled();
	expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/login magpie"), "warning");
});

it("sanitizes unexpected registry failures", async () => {
	const { refresh, notify, run } = await setup();
	refresh.mockRejectedValueOnce(new Error("SECRET registry failure"));
	await run();
	expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Magpie model refresh failed"), "error");
	expect(JSON.stringify(notify.mock.calls)).not.toContain("SECRET");
});
