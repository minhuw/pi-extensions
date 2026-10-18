import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import * as builtin from "@earendil-works/pi-ai/providers/all";
import type { createMagpieStreams, MagpieApi } from "../streams.ts";

// Use Pi's loader dependency and virtual-module contract, with no node_modules
// beside the copied extension. A developer checkout must not mask missing APIs.
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
let directory: string | undefined;
afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

it("loads native streams through Pi's virtual providers module in a clean checkout", async () => {
	directory = mkdtempSync(join(tmpdir(), "magpie-streams-loader-"));
	const filename = join(directory, "streams.ts");
	copyFileSync(fileURLToPath(new URL("../streams.ts", import.meta.url)), filename);
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		virtualModules: { "@earendil-works/pi-ai/providers/all": builtin },
	});
	const loaded = await jiti.import(filename) as { createMagpieStreams: typeof createMagpieStreams };
	const streams = loaded.createMagpieStreams();
	const fetch = vi.fn().mockImplementation(async () => Response.json({ error: { message: "fixture rejection" } }, { status: 400 }));
	vi.stubGlobal("fetch", fetch);
	const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
	for (const [api, endpoint] of [
		["openai-completions", "/v1/chat/completions"],
		["openai-responses", "/v1/responses"],
		["anthropic-messages", "/v1/messages"],
	] as const) {
		const model: Model<MagpieApi> = {
			id: "fixture-model", provider: "magpie", name: "Fixture", api,
			baseUrl: api === "anthropic-messages" ? "https://gateway.example" : "https://gateway.example/v1",
			reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		for (const method of ["stream", "streamSimple"] as const) {
			fetch.mockClear();
			const result = await streams[api][method](model, context, { apiKey: "magpie-fixture" }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("fixture rejection");
			expect(fetch).toHaveBeenCalledOnce();
			const [url, init] = fetch.mock.calls[0];
			const requestUrl = new URL(String(url));
			expect(requestUrl.origin + requestUrl.pathname).toBe(`https://gateway.example${endpoint}`);
			const headers = new Headers(init.headers);
			expect(headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"))
				.toBe(api === "anthropic-messages" ? "magpie-fixture" : "Bearer magpie-fixture");
		}
	}
});
