import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMPACTION_CONFIG_FILE, loadMagpieCompactionConfig, registerMagpieCompaction } from "../compaction.ts";
import { parseModels } from "../index.ts";

let root: string;
let agentDir: string;
let project: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-magpie-compaction-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(project, ".pi"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});
const saveConfig = (value: unknown, directory = agentDir) => writeFileSync(join(directory, COMPACTION_CONFIG_FILE), JSON.stringify(value));
const model = parseModels({ data: [{ id: "codex/gpt-6.1-sol", native_endpoints: ["/v1/responses"] }] }, "http://127.0.0.1:3425")[0];

describe("Magpie-owned compaction configuration", () => {
	it("defaults to enabled and does not read legacy configuration", () => {
		writeFileSync(join(agentDir, "cliproxyapi-native-compaction.json"), JSON.stringify({ enabled: true, models: [model.id] }));
		expect(loadMagpieCompactionConfig(project, false)).toEqual({
			enabled: true, providerId: "magpie", apiId: "openai-responses", models: [], fallbackToBuiltin: true,
		});
	});
	it("merges only trusted project overrides and deduplicates exact IDs", () => {
		saveConfig({ enabled: true, models: [model.id, model.id] });
		saveConfig({ models: ["openai/another-model"], fallbackToBuiltin: false }, join(project, ".pi"));
		expect(loadMagpieCompactionConfig(project, false)).toMatchObject({ enabled: true, models: [model.id], fallbackToBuiltin: true });
		expect(loadMagpieCompactionConfig(project, true)).toMatchObject({ enabled: true, models: ["openai/another-model"], fallbackToBuiltin: false });
	});
	it("automatically selects GPT, ChatGPT and o-series Responses names across arbitrary providers", () => {
		const ids = [model.id, "gpt-6.1-sol", "relay/gpt-future", "another/nested/o99", "o3-mini", "custom/chatgpt-future", "group/gpt-6-astra"];
		const catalog = [
			...ids.map(id => ({ ...model, id })), model,
			...[
				"group/fast", "deepseek/chat", "anthropic/claude", "alias/gpt", "openai/", "codex/",
				"openai/*", "codex/?", "openai/[model]", "openai/has space", "codex/line\n",
				"codex/future-model", "openai/claude-opus-4-6", "gpt-", "chatgpt-", "other/oops", "gpt4",
				"/gpt-6-astra", "relay//gpt-6-astra", "relay/gpt-6-astra*", "gpt-6\u0000-astra",
			].map(id => ({ ...model, id })),
			{ ...model, provider: "other" }, { ...model, api: "openai-completions" },
		];
		expect(loadMagpieCompactionConfig(project, false, catalog)).toMatchObject({
			enabled: true, models: ids, fallbackToBuiltin: true,
		});
	});
	it("uses the model name independently of owner while retaining the Responses requirement", () => {
		const catalog = parseModels({ data: [
			{ id: "gpt-6-astra", owned_by: "unrelated", native_endpoints: ["/v1/responses"] },
			{ id: "any-provider/gpt-6-astra", owned_by: null, native_endpoints: ["/v1/responses"] },
			{ id: "misleading/claude-opus-4-6", owned_by: "openai", native_endpoints: ["/v1/responses"] },
			{ id: "gpt-chat-only", native_endpoints: ["/v1/chat/completions"] },
			{ id: "gpt-messages-only", native_endpoints: ["/v1/messages"] },
			{ id: "gpt-group", owned_by: "codex" },
		] }, "http://127.0.0.1:3425");
		expect(loadMagpieCompactionConfig(project, false, [...catalog, catalog[0]]).models)
			.toEqual(["gpt-6-astra", "any-provider/gpt-6-astra"]);
	});
	it("accepts explicitly verified exact bare IDs and replaces automatic discovery", () => {
		saveConfig({ models: ["verified-bare", "verified-bare", "custom/verified"] });
		expect(loadMagpieCompactionConfig(project, false, [model]).models).toEqual(["verified-bare", "custom/verified"]);
	});
	it.each(["verified-bare", "old-provider/verified-bare"])("matches explicit %s by model name across gateway providers", configured => {
		saveConfig({ models: [configured] });
		const ids = ["verified-bare", "relay/verified-bare", "nested/provider/verified-bare"];
		const catalog = [
			...ids.map(id => ({ ...model, id })),
			{ ...model, id: "relay/unlisted" },
			{ ...model, id: "chat/verified-bare", api: "openai-completions" },
			{ ...model, id: "foreign/verified-bare", provider: "other" },
		];
		expect(loadMagpieCompactionConfig(project, false, catalog).models).toEqual([...new Set([configured, ...ids])]);
		saveConfig({ models: [] });
		expect(loadMagpieCompactionConfig(project, false, catalog).models).toEqual([]);
	});
	it("honors explicit optouts and lists instead of adding automatic IDs", () => {
		saveConfig({ models: [] });
		expect(loadMagpieCompactionConfig(project, false, [model]).models).toEqual([]);
		saveConfig({ enabled: false });
		expect(loadMagpieCompactionConfig(project, false, [model])).toMatchObject({ enabled: false, models: [model.id] });
		saveConfig({ models: ["custom/verified", "custom/verified"] });
		expect(loadMagpieCompactionConfig(project, false, [model]).models).toEqual(["custom/verified"]);
	});
	it("preserves trusted field overrides with automatic discovery", () => {
		saveConfig({ enabled: false });
		saveConfig({ enabled: true }, join(project, ".pi"));
		expect(loadMagpieCompactionConfig(project, false, [model])).toMatchObject({ enabled: false, models: [model.id] });
		expect(loadMagpieCompactionConfig(project, true, [model])).toMatchObject({ enabled: true, models: [model.id] });
		saveConfig({ models: [] }, join(project, ".pi"));
		expect(loadMagpieCompactionConfig(project, true, [model]).models).toEqual([]);
	});

	it.each([
		null, [], { enabled: "true" }, { fallbackToBuiltin: 1 }, { models: ["gpt-{a,b}"] },
		{ models: ["openai/*"] }, { models: ["gpt-*"] }, { models: ["gpt-?"] }, { models: ["gpt-[6]"] },
		{ models: ["gpt-6\n"] }, { models: ["gpt-6\u0000"] }, { models: ["relay//gpt-6"] },
		{ models: ["has space"] }, { models: ["/gpt"] }, { models: ["codex/"] }, { models: [" openai/gpt"] },
		{ models: [""] }, { models: [12] }, { models: "openai/gpt" },
		{ providerId: "other" }, { apiId: "openai-completions" }, { endpoint: "https://elsewhere.example/responses" },
	])("rejects invalid or unsafe configuration %j", value => {
		saveConfig(value);
		expect(() => loadMagpieCompactionConfig(project, false)).toThrow();
	});
	it("ignores an invalid untrusted project file", () => {
		writeFileSync(join(project, ".pi", COMPACTION_CONFIG_FILE), "invalid");
		expect(loadMagpieCompactionConfig(project, false).enabled).toBe(true);
		expect(() => loadMagpieCompactionConfig(project, true)).toThrow("valid JSON");
	});
});

function harness(selectedModel = model, catalog = [selectedModel]) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, any>();
	registerMagpieCompaction({
		on: (name: string, handler: any) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: any) => { commands.set(name, command); },
		getAllTools: () => [],
	} as unknown as ExtensionAPI);
	const session = SessionManager.inMemory();
	const firstId = session.appendMessage({ role: "user", content: "remember this", timestamp: 0 });
	const ctx = {
		cwd: project, model: selectedModel, hasUI: true, isProjectTrusted: () => false,
		sessionManager: session,
		modelRegistry: { getAll: () => catalog, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "magpie-pi", headers: {} }) },
		ui: { notify: vi.fn() }, abort: vi.fn(),
	} as unknown as ExtensionContext;
	const event = () => ({
		branchEntries: session.getBranch(), preparation: { firstKeptEntryId: firstId, tokensBefore: 100 },
		signal: new AbortController().signal, reason: "manual",
	});
	return { handlers, commands, session, ctx, event };
}

it("compacts and replays through the Magpie-only registration, including after disabling new compactions", async () => {
	const { handlers, commands, session, ctx, event } = harness();
	const fetch = vi.fn().mockResolvedValue(Response.json({ output: [{ type: "compaction", encrypted_content: "sealed" }] }));
	vi.stubGlobal("fetch", fetch);
	expect(commands.has("magpie-native-compaction")).toBe(true);
	const result = await handlers.get("session_before_compact")!(event(), ctx);
	expect(fetch).toHaveBeenCalledOnce();
	expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:3425/v1/responses");
	expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: model.id, input: expect.arrayContaining([{ type: "compaction_trigger" }]) });
	expect(result.compaction.details.modelKey).toBe(`magpie:openai-responses:${model.id}`);
	const compacted = result.compaction;
	session.appendCompaction(compacted.summary, compacted.firstKeptEntryId, compacted.tokensBefore, JSON.parse(JSON.stringify(compacted.details)));
	session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
	saveConfig({ enabled: false, models: [] });
	const payload = await handlers.get("before_provider_request")!({ payload: { input: [], previous_response_id: "obsolete" } }, ctx);
	expect(payload.input).toContainEqual({ type: "compaction", encrypted_content: "sealed" });
	expect(payload.input.at(-1)).toEqual({ role: "user", content: [{ type: "input_text", text: "continue" }] });
	expect(payload).not.toHaveProperty("previous_response_id");
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toEqual({ cancel: true });
	expect(fetch).toHaveBeenCalledOnce();
});

it.each(["gpt-6-astra", "custom-relay/gpt-6-astra"])("compacts and replays %s while retaining exact checkpoint identity", async id => {
	const [bare] = parseModels({ data: [{ id, native_endpoints: ["/v1/responses"] }] }, "http://127.0.0.1:3425");
	const { handlers, session, ctx, event } = harness(bare);
	const fetch = vi.fn().mockResolvedValue(Response.json({ output: [{ type: "compaction", encrypted_content: "sealed-bare" }] }));
	vi.stubGlobal("fetch", fetch);
	const { compaction } = await handlers.get("session_before_compact")!(event(), ctx);
	expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(bare.id);
	expect(compaction.details.modelKey).toBe(`magpie:openai-responses:${bare.id}`);
	session.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details);
	session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
	const payload = await handlers.get("before_provider_request")!({ payload: { model: bare.id, input: [] } }, ctx);
	expect(payload.model).toBe(bare.id);
	expect(payload.input).toContainEqual({ type: "compaction", encrypted_content: "sealed-bare" });
	ctx.model = { ...bare, id: "codex/gpt-6-astra" };
	expect(await handlers.get("before_provider_request")!({ payload: { input: [] } }, ctx)).toEqual({ input: [] });
	expect(ctx.abort).toHaveBeenCalledOnce();
	expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("request blocked"), "error");
});

it("binds a local Claude alias's compaction and replay to its physical source", async () => {
	const catalog = parseModels({ data: [{ id: "claude1/claude-opus-5-5", owned_by: "claude1", native_endpoints: ["/v1/responses"] }] }, "http://127.0.0.1:3425");
	const source = catalog[0];
	const alias = catalog.find(model => model.magpieAliasTarget)!;
	saveConfig({ models: [alias.id], fallbackToBuiltin: false });
	const { handlers, session, ctx, event } = harness(alias, catalog);
	const fetch = vi.fn().mockResolvedValue(Response.json({ output: [{ type: "compaction", encrypted_content: "claude-sealed" }] }));
	vi.stubGlobal("fetch", fetch);
	const { compaction } = await handlers.get("session_before_compact")!(event(), ctx);
	expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(source.id);
	expect(compaction.details.modelKey).toBe(`magpie:openai-responses:${source.id}`);
	session.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details);
	session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
	const replay = () => handlers.get("before_provider_request")!({ payload: { model: source.id, input: [] } }, ctx);
	expect((await replay()).input).toContainEqual({ type: "compaction", encrypted_content: "claude-sealed" });
	ctx.model = source;
	expect((await replay()).input).toContainEqual({ type: "compaction", encrypted_content: "claude-sealed" });
	expect(ctx.abort).not.toHaveBeenCalled();
	const changed = parseModels({ data: [{ id: "claude2/claude-opus-5-5", owned_by: "claude2", native_endpoints: ["/v1/responses"] }] }, "http://127.0.0.1:3425");
	ctx.model = changed.find(model => model.magpieAliasTarget)!;
	expect((await replay()).input).toEqual([]);
	expect(ctx.abort).toHaveBeenCalledOnce();
});

it("shows the automatic exact allowlist without a config file or network", async () => {
	const { commands, ctx } = harness();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await commands.get("magpie-native-compaction").handler("", ctx);
	expect(ctx.ui.notify).toHaveBeenCalledWith(
		`Enabled for magpie/${model.id}. Fallback to built-in: on. Allowlist: ${model.id}.`, "info",
	);
	expect(fetch).not.toHaveBeenCalled();
});

it("does not enable a stale selected model absent from the registry", async () => {
	const { handlers, ctx, event } = harness();
	vi.spyOn(ctx.modelRegistry, "getAll").mockReturnValue([]);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toBeUndefined();
	expect(fetch).not.toHaveBeenCalled();
});

it.each([{ enabled: false }, { models: [] }])("uses built-in compaction for explicit optout %j", async config => {
	saveConfig(config);
	const { handlers, ctx, event } = harness();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toBeUndefined();
	expect(fetch).not.toHaveBeenCalled();
});

it("defaults to fallback only before a checkpoint and cancels failures after it", async () => {
	const { handlers, session, ctx, event } = harness();
	const fetch = vi.fn().mockImplementation(async () => new Response("native compaction unsupported", { status: 400 }));
	vi.stubGlobal("fetch", fetch);
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toBeUndefined();
	expect(session.getBranch().some(entry => entry.type === "compaction")).toBe(false);
	expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("falling back"), "warning");
	fetch.mockResolvedValueOnce(Response.json({ output: [{ type: "compaction", encrypted_content: "sealed" }] }));
	const { compaction } = await handlers.get("session_before_compact")!(event(), ctx);
	session.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details);
	session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toEqual({ cancel: true });
	expect(fetch).toHaveBeenCalledTimes(3);
	const payload = await handlers.get("before_provider_request")!({ payload: { input: [] } }, ctx);
	expect(payload.input).toContainEqual({ type: "compaction", encrypted_content: "sealed" });
});

it("pairs the resolved login key with its gateway, not a stale selected model endpoint", async () => {
	saveConfig({ enabled: true, models: [model.id], fallbackToBuiltin: false });
	const { handlers, ctx, event } = harness();
	vi.spyOn(ctx.modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({
		ok: true, apiKey: "saved-key", baseUrl: "https://saved-gateway.example/v1", headers: {},
	});
	const fetch = vi.fn().mockResolvedValue(Response.json({ output: [{ type: "compaction", encrypted_content: "sealed" }] }));
	vi.stubGlobal("fetch", fetch);
	const result = await handlers.get("session_before_compact")!(event(), ctx);
	expect(result.compaction).toBeDefined();
	expect(fetch).toHaveBeenCalledOnce();
	expect(fetch.mock.calls[0][0]).toBe("https://saved-gateway.example/v1/responses");
	expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer saved-key");
	expect(ctx.model?.baseUrl).toBe("http://127.0.0.1:3425/v1");
});

it("uses ordinary compaction for a non-eligible model and cancels on bad configuration", async () => {
	const { handlers, ctx, event } = harness();
	ctx.model = { ...model, id: "deepseek/chat" };
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toBeUndefined();
	saveConfig({ enabled: "true" });
	expect(await handlers.get("session_before_compact")!(event(), ctx)).toEqual({ cancel: true });
	expect(fetch).not.toHaveBeenCalled();
});

it("loads and registers compaction from the Magpie directory alone", () => {
	const extensions = join(root, "extensions");
	mkdirSync(extensions);
	cpSync(resolve("extensions/magpie-provider"), join(extensions, "magpie-provider"), { recursive: true });
	symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	const entry = pathToFileURL(join(extensions, "magpie-provider/index.ts")).href;
	const script = `
		import assert from 'node:assert/strict';
		globalThis.fetch = () => { throw new Error('No network allowed'); };
		const { default: extension } = await import(${JSON.stringify(entry)});
		const events = [], commands = [], providers = [];
		await extension({ registerProvider: p => providers.push(p), on: n => events.push(n), registerCommand: n => commands.push(n) });
		assert.equal(providers[0].id, 'magpie');
		assert.ok(events.includes('session_before_compact'));
		assert.ok(events.includes('before_provider_request'));
		assert.ok(commands.includes('magpie-native-compaction'));
	`;
	expect(() => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
		cwd: root, env: { ...process.env, PI_OFFLINE: "1", MAGPIE_BASE_URL: "http://127.0.0.1:3425", MAGPIE_API_KEY: "", PI_CODING_AGENT_DIR: agentDir }, timeout: 15000,
		stdio: "pipe",
	})).not.toThrow();
	// The outer deadline must exceed the child process's 15-second SDK-loading bound.
}, 20_000);
