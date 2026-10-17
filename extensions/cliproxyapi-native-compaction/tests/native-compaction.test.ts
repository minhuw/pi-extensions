import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import * as configModule from "../config.ts";
import {
	DEFAULT_NATIVE_MODELS,
	isEligibleModel,
	type NativeCompactionConfig,
} from "../config.ts";

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
	models: [...DEFAULT_NATIVE_MODELS],
	fallbackToBuiltin: true,
};

describe("model capability gate", () => {
	it("defaults to the supported OpenAI aliases", () => {
		expect(DEFAULT_NATIVE_MODELS).toEqual([
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-6-astra",
		]);
	});

	it.each(DEFAULT_NATIVE_MODELS)("accepts default OpenAI model %s", (id) => {
		expect(isEligibleModel({ ...model, id }, config)).toBe(true);
	});

	it("rejects models outside the exact CLIProxyAPI Codex allowlist", () => {
		expect(isEligibleModel({ ...model, id: "kimi-k3" }, config)).toBe(false);
		expect(isEligibleModel({ ...model, provider: "openai-compatible" }, config)).toBe(false);
		expect(isEligibleModel({ ...model, api: "openai-completions" }, config)).toBe(false);
	});
});


it("reserves Magpie even when legacy configuration explicitly retargets it", async () => {
	const load = vi.spyOn(configModule, "loadConfig").mockReturnValue({
		...config, providerId: "magpie", apiId: "openai-responses",
	});
	try {
		const handlers: Record<string, (event: any, ctx: ExtensionContext) => any> = {};
		extension({
			on: (name: string, handler: any) => { handlers[name] = handler; },
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: "/tmp", isProjectTrusted: () => false,
			model: { ...model, provider: "magpie", api: "openai-responses" },
		} as unknown as ExtensionContext;
		expect(await handlers.session_before_compact!({ branchEntries: [] }, ctx)).toBeUndefined();
	} finally {
		load.mockRestore();
	}
});
