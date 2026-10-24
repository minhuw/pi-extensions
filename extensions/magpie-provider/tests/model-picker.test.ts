import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMagpieProvider, parseModels } from "../index.ts";
import { selectMagpiePickerModels } from "../model-picker.ts";

const env = { MAGPIE_BASE_URL: "http://127.0.0.1:3425", MAGPIE_API_KEY: "fixture-key" };
const gpt = { owned_by: "codex", display_name: "Original GPT", native_endpoints: ["/v1/responses"], modalities: { input: ["text", "image"] } };
const claude = { owned_by: "contabo", display_name: "Original Claude", native_endpoints: ["/v1/messages"] };
const catalog = [
	{ ...gpt, id: "codex/gpt-6-astra" },
	{ ...claude, id: "contabo/claude/claude-opus-5-5" },
	{ ...gpt, id: "gpt-6-astra" },
	{ ...claude, id: "claude/claude-opus-5-5" },
];
const visible = [
	{ id: "gpt-6-astra", name: "gpt-6-astra", api: "openai-responses" },
	{ id: "claude-opus-5-5", name: "claude-opus-5-5", api: "anthropic-messages", magpieAliasTarget: "contabo/claude/claude-opus-5-5" },
];
const parse = (data: unknown[]) => parseModels({ data }, env.MAGPIE_BASE_URL);
let directory: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("source-aware picker selection", () => {
	it("shows a short Claude alias only for one concrete source and keeps groups separate", () => {
		const models = parse([
			{ ...claude, id: "auto/claude-opus-5-5", native_endpoints: undefined }, ...catalog,
		]);
		const selected = selectMagpiePickerModels(models);
		expect(selected.map(model => model.id)).toEqual(["auto/claude-opus-5-5", "gpt-6-astra", "claude-opus-5-5"]);
		expect(selected[0].magpieRoute?.group).toBe(true);
		expect(selected[2].magpieAliasTarget).toBe("contabo/claude/claude-opus-5-5");
	});

	it("keeps both providers qualified when claude1 and claude2 serve the same name", () => {
		const models = parse([
			{ ...claude, owned_by: "claude1", id: "claude1/claude-opus-5-5" },
			{ ...claude, owned_by: "claude2", id: "claude2/claude-opus-5-5" },
		]);
		expect(selectMagpiePickerModels(models).map(model => model.id))
			.toEqual(["claude1/claude-opus-5-5", "claude2/claude-opus-5-5"]);
		expect(models.some(model => model.magpieAliasTarget)).toBe(false);
	});

	it("keeps same-owner nested sources and unknown-owner rows separate", () => {
		for (const owned_by of ["contabo", undefined]) {
			const models = parse([
				{ ...claude, owned_by, id: "contabo/claude1/claude-opus-5-5" },
				{ ...claude, owned_by, id: "contabo/claude2/claude-opus-5-5" },
			]);
			expect(selectMagpiePickerModels(models)).toHaveLength(2);
			expect(models.some(model => model.magpieAliasTarget)).toBe(false);
		}
	});

	it("keeps canonical qualified IDs when a gateway bare alias has another competing source", () => {
		const models = parse([
			{ ...gpt, id: "codex/gpt-6-astra" }, { ...gpt, id: "gpt-6-astra" },
			{ ...gpt, owned_by: "relay", id: "relay/gpt-6-astra" },
		]);
		expect(selectMagpiePickerModels(models).map(model => model.id)).toEqual(["codex/gpt-6-astra", "relay/gpt-6-astra"]);
	});

	it("does not merge unknown rows merely because the name matches", () => {
		const models = parse([{ id: "a/model" }, { id: "b/model" }, { id: "model" }]);
		expect(selectMagpiePickerModels(models).map(model => model.id)).toEqual(["a/model", "b/model", "model"]);
	});

	it("keeps case and suffix variants distinct", () => {
		const names = ["claude-model", "claude-Model", "claude-model-fast", "claude-model@500k"];
		const models = parse(names.map(name => ({ ...claude, id: `contabo/${name}` })));
		expect(selectMagpiePickerModels(models).map(model => model.id)).toEqual(names);
	});

	it("preserves the complete catalog and selected source metadata without mutation", () => {
		const models = parse(catalog);
		const before = structuredClone(models);
		for (const model of models) Object.freeze(model);
		Object.freeze(models);
		const selected = selectMagpiePickerModels(models);
		expect(selected).toMatchObject(visible);
		expect(selected).toHaveLength(2);
		expect(models).toEqual(before);
		expect(models.map(model => model.id)).toEqual([...catalog.map(row => row.id), "claude-opus-5-5"]);
		for (const model of selected) {
			const original = models.find(candidate => candidate.id === model.id)!;
			expect(model).toEqual({ ...original, name: model.id });
			expect(model.cost).toBe(original.cost);
		}
		expect(selectMagpiePickerModels(models, true)).toEqual(models);
	});
});

describe("native availability integration", () => {
	it("registers local short IDs for lookup while hiding only proven aliases in both availability APIs", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: catalog })));
		const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: {
			env: async () => undefined, fileExists: async () => false,
		} });
		const provider = createMagpieProvider(env);
		models.setProvider(provider);
		expect((await models.refresh({ providers: ["magpie"], force: true })).errors.size).toBe(0);
		const raw = provider.getModels();
		expect(raw).toHaveLength(5);
		expect(models.getModels("magpie")).toEqual(raw);
		const available = await models.getAvailable("magpie");
		expect(available).toMatchObject(visible);
		expect(available).toHaveLength(2);
		expect(await models.getAllAvailable("magpie")).toEqual(available);
		expect(models.getModel("magpie", "codex/gpt-6-astra")).toBe(raw[0]);
		expect(models.getModel("magpie", "contabo/claude/claude-opus-5-5")).toBe(raw[1]);
		expect(models.getModel("magpie", "claude-opus-5-5")).toMatchObject({ magpieAliasTarget: raw[1].id });
	});

	it("preserves original scope IDs, order, display matching and thinking levels", async () => {
		directory = mkdtempSync(join(tmpdir(), "magpie-picker-scoped-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: catalog })));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
		const refresh = vi.spyOn(runtime, "refresh");
		let scoped = true;
		const provider = createMagpieProvider(env, undefined, undefined, () => scoped);
		runtime.registerNativeProvider(provider);
		await refresh.mock.results[0].value;
		await runtime.refresh({ providers: ["magpie"], allowNetwork: true, force: true });
		const patterns = ["magpie/contabo/claude/claude-opus-5-5:low", "magpie/codex/gpt-6-astra:high"];
		const resolved = await resolveModelScopeWithDiagnostics(patterns, runtime);
		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.scopedModels.map(({ model, thinkingLevel }) => [model.id, thinkingLevel])).toEqual([
			["contabo/claude/claude-opus-5-5", "low"], ["codex/gpt-6-astra", "high"],
		]);
		const availableIds = new Set(runtime.getAvailableSnapshot().map(model => model.id));
		expect(resolved.scopedModels.every(({ model }) => availableIds.has(model.id))).toBe(true);
		expect(availableIds.has("claude-opus-5-5")).toBe(true);
		const localScope = await resolveModelScopeWithDiagnostics(["magpie/claude-opus-5-5:high"], runtime);
		expect(localScope.diagnostics).toEqual([]);
		expect(localScope.scopedModels[0]?.model.id).toBe("claude-opus-5-5");
		const wildcard = await resolveModelScopeWithDiagnostics(["magpie/codex/*:high"], runtime);
		expect(wildcard.scopedModels.map(({ model }) => model.id)).toEqual(["codex/gpt-6-astra"]);
		const byDisplayName = await resolveModelScopeWithDiagnostics(["Original GPT:high"], runtime);
		expect(byDisplayName.scopedModels[0]?.model.id).toBe("gpt-6-astra");
		scoped = false;
		await runtime.refresh({ providers: ["magpie"], allowNetwork: false, force: true });
		expect(runtime.getAvailableSnapshot()).toMatchObject(visible);
		expect(runtime.getAvailableSnapshot()).toHaveLength(2);
	});

	it("removes ambiguous local aliases on refresh and retains the last successful catalog on failure", async () => {
		directory = mkdtempSync(join(tmpdir(), "magpie-picker-refresh-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: catalog })));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
		const refresh = vi.spyOn(runtime, "refresh");
		const provider = createMagpieProvider(env);
		runtime.registerNativeProvider(provider);
		await refresh.mock.results[0].value;
		const reload = () => runtime.refresh({ providers: ["magpie"], allowNetwork: true, force: true });
		await reload();
		expect(runtime.getAvailableSnapshot()).toMatchObject(visible);
		vi.mocked(fetch).mockImplementation(async () => Response.json({ data: [
			...catalog, { ...claude, owned_by: "claude2", id: "claude2/claude-opus-5-5" },
		] }));
		expect((await reload()).errors.size).toBe(0);
		expect(runtime.getModel("magpie", "claude-opus-5-5")).toBeUndefined();
		expect(runtime.getAvailableSnapshot().map(model => model.id)).toEqual([
			"contabo/claude/claude-opus-5-5", "gpt-6-astra", "claude2/claude-opus-5-5",
		]);
		const previous = provider.getModels();
		const previousVisible = runtime.getAvailableSnapshot();
		vi.mocked(fetch).mockRejectedValue(new Error("fixture offline"));
		expect((await reload()).errors.has("magpie")).toBe(true);
		expect(provider.getModels()).toBe(previous);
		expect(runtime.getAvailableSnapshot()).toEqual(previousVisible);
	});
});
