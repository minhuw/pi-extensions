import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../catalog-pricing.ts", async importOriginal => ({ ...await importOriginal<object>(), loadModelsDevPricing: async () => undefined }));
import { createMagpieProvider, parseModels } from "../index.ts";

const origin = "https://gateway.example";
const name = "gpt-6-luna";
const group = { id: `auto/${name}`, owned_by: "remote", context_window: 64000, max_output_tokens: 2048, reasoning_levels: ["high"] };
const concrete = { id: `remote/codex/${name}`, owned_by: "remote", native_endpoints: ["/v1/responses"], context_window: 272000 };
const parse = (data: unknown[]) => parseModels({ data }, origin);
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "magpie-group-responses-")); vi.stubEnv("PI_CODING_AGENT_DIR", directory); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it.each([false, true])("selects Responses for a group and its short alias (advertised=%s) without borrowing limits", advertised => {
	const models = parse([group, concrete, { ...concrete, id: `codex/${name}`, owned_by: "codex" },
		...(advertised ? [{ ...group, id: name }] : [])]);
	for (const id of [group.id, name]) {
		const model = models.find(model => model.id === id)!;
		expect(model).toMatchObject({ api: "openai-responses", baseUrl: `${origin}/v1`, contextWindow: 64000, maxTokens: 2048,
			thinkingLevelMap: { high: "high", max: null }, magpieRoute: { canonicalId: group.id, group: true } });
		expect(model.compat).toBeUndefined();
		expect(model.magpieAliasTarget).toBe(id === name && !advertised ? group.id : undefined);
	}
});

it.each([
	{ label: "no concrete routes", rows: [] },
	{ label: "different model name", rows: [{ ...concrete, id: "remote/gpt-other" }] },
	{ label: "different case", rows: [{ ...concrete, id: "remote/GPT-6-luna" }] },
	{ label: "only other groups", rows: [{ ...concrete, id: `group/${name}` }] },
	{ label: "a Chat-only source", rows: [concrete, { ...concrete, id: `chat/${name}`, native_endpoints: ["/v1/chat/completions"] }] },
	{ label: "a Messages-only source", rows: [concrete, { ...concrete, id: `messages/${name}`, native_endpoints: ["/v1/messages"] }] },
	{ label: "an unknown source", rows: [concrete, { id: `unknown/${name}` }] },
])("retains Chat Completions with $label", ({ rows }) => {
	const models = parse([group, ...rows]);
	expect(models.find(model => model.id === name)?.api).toBe("openai-completions");
});

it.each(["/v1/chat/completions", "/v1/messages"])("respects a group's explicit %s endpoint", endpoint => {
	const models = parse([{ ...group, native_endpoints: [endpoint] }, concrete]);
	expect(models.find(model => model.id === name)?.api).toBe(endpoint === "/v1/messages" ? "anthropic-messages" : "openai-completions");
});

it("does not promote an unrelated bare route or infer from display names", () => {
	const models = parse([{ id: name }, { ...concrete, id: "remote/other", display_name: name }]);
	expect(models.find(model => model.id === name)?.api).toBe("openai-completions");
});

it("recomputes the group API when discovery adds or removes conflicting sources", async () => {
	let rows: unknown[] = [group, concrete];
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: rows })));
	const provider = createMagpieProvider({ MAGPIE_BASE_URL: origin, MAGPIE_API_KEY: "fixture-key" });
	const refresh = () => provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
		publish: async ({ update }) => { update?.(); return true; } });
	await refresh();
	expect(provider.getModels().find(model => model.id === name)?.api).toBe("openai-responses");
	rows = [group, concrete, { id: `unknown/${name}` }];
	await refresh();
	expect(provider.getModels().find(model => model.id === name)?.api).toBe("openai-completions");
	rows = [group, concrete];
	await refresh();
	expect(provider.getModels().find(model => model.id === name)?.api).toBe("openai-responses");
});

it.each([false, true])("sends the priority tier through the real Responses delegate while retaining group routing (advertised=%s)", async advertised => {
	const rows = [group, concrete, ...(advertised ? [{ ...group, id: name }] : [])];
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: rows })));
	const provider = createMagpieProvider({ MAGPIE_BASE_URL: origin, MAGPIE_API_KEY: "fixture-key" });
	await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
		publish: async ({ update }) => { update?.(); return true; } });
	const model = provider.getModels().find(model => model.id === name)!;
	const requests: Request[] = [];
	const mockedFetch: typeof fetch = async (input, init) => {
		requests.push(new Request(input, init));
		return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
			id: "response-1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
		} })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
	for (const method of ["stream", "streamSimple"] as const) {
		const options = { apiKey: "fixture-key", fetch: mockedFetch, maxRetries: 0, serviceTier: "priority" as const,
			// Subagents pins the tier after the SDK's simple-options conversion too.
			onPayload: (payload: unknown) => ({ ...payload as Record<string, unknown>, service_tier: "priority" }) };
		const result = await provider[method](model, context, options).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		const request = requests.at(-1)!;
		expect(request.url).toBe(`${origin}/v1/responses`);
		expect(await request.json()).toMatchObject({ model: advertised ? name : group.id, service_tier: "priority" });
		expect(result.model).toBe(name);
	}
	expect(requests).toHaveLength(2);
});
