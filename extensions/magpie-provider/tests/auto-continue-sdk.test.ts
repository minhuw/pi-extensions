import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../catalog-pricing.ts", async original => ({ ...await original<object>(), loadModelsDevPricing: async () => undefined }));
import magpie, { parseModels } from "../index.ts";

const origin = "https://quota-fixture.example";
const catalog = { data: [
	{ id: "auto/gpt-fixture", owned_by: "codex" },
	{ id: "codex/gpt-fixture", owned_by: "codex", native_endpoints: ["/v1/responses"] },
] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("continues a real Pi session once after core retries settle, preserving its original conversation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "magpie-quota-sdk-"));
	let session: AgentSession | undefined;
	try {
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("MAGPIE_BASE_URL", origin);
		vi.stubEnv("MAGPIE_API_KEY", "fixture-key");
		const sessionManager = SessionManager.inMemory(directory);
		const statuses = new Map<string, string>();
		const errors: string[] = [];
		let limited = true;
		let quotaRequests = 0;
		let routeRequests = 0;
		const bodies: Record<string, unknown>[] = [];
		const reset = Date.now() + 60_000;
		vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const req = new Request(input, init);
			const url = new URL(req.url);
			if (url.origin !== origin) throw new Error("Unexpected network request");
			expect(req.headers.get("authorization")).toBe("Bearer fixture-key");
			if (url.pathname === "/v1/models") return Response.json(catalog);
			if (url.pathname === "/v1/magpie/quotas") {
				quotaRequests++;
				return Response.json({ object: "list", data: [{ provider: "codex", kind: "subscription",
					windows: [{ used: 100, remaining: 0, resetsAt: new Date(reset).toISOString() }] }] });
			}
			if (url.pathname === "/v1/magpie/route") {
				routeRequests++;
				expect(url.searchParams.get("session")).toBe(sessionManager.getSessionId());
				return Response.json({ session: sessionManager.getSessionId(), route: {
					asked: "auto/gpt-fixture", time: new Date().toISOString(), done: true, status: 429,
					tries: [{ model: "codex/gpt-fixture", done: true, status: 429, fail: "quota" }],
				} });
			}
			if (url.pathname !== "/v1/responses") throw new Error("Unexpected endpoint");
			bodies.push(JSON.parse(await req.text()));
			if (limited) return Response.json({ error: { type: "rate_limit_error", message: "Usage limit reached" } },
				{ status: 429, headers: { "retry-after": "0" } });
			const events = [
				{ type: "response.created", response: { id: "resp-resumed" } },
				{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-resumed", role: "assistant", content: [], status: "in_progress" } },
				{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Task resumed." },
				{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-resumed", role: "assistant", content: [{ type: "output_text", text: "Task resumed.", annotations: [] }], status: "completed" } },
				{ type: "response.completed", response: { id: "resp-resumed", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
			];
			return new Response(events.map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } });
		}));
		const settingsManager = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 10 } });
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
		const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [magpie],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, modelRuntime, resourceLoader,
			sessionManager, model: parseModels(catalog, origin).find(m => m.id === "gpt-fixture")!, thinkingLevel: "off", noTools: "all" }));
		await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error), uiContext: {
			...session.extensionRunner!.createContext().ui,
			setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text), notify: () => {},
		} });
		let coreRetries = 0;
		session.subscribe(event => { if (event.type === "auto_retry_start") coreRetries++; });
		await session.prompt("Finish the original fixture task.");
		expect(coreRetries).toBe(1);
		expect(quotaRequests).toBe(1);
		expect(routeRequests).toBe(1);
		expect(statuses.get("magpie-quota")).toContain("quota awaiting");
		const attemptedBeforeReset = bodies.length;
		expect(attemptedBeforeReset).toBeGreaterThanOrEqual(2);

		// Move wall time beyond the observed reset, then re-arm the saved wait
		// through the real command. The one-shot timer and Pi dispatch stay real.
		limited = false;
		vi.spyOn(Date, "now").mockReturnValue(reset + 30_001);
		let complete!: () => void;
		const completed = new Promise<void>(resolve => { complete = resolve; });
		session.subscribe(event => { if (event.type === "agent_settled") complete(); });
		await session.prompt("/magpie-auto-continue resume");
		await completed;
		expect(session.messages.findLast(m => m.role === "assistant")).toMatchObject({ stopReason: "stop", model: "gpt-fixture" });
		expect(session.getLastAssistantText()).toBe("Task resumed.");
		expect(bodies).toHaveLength(attemptedBeforeReset + 1);
		expect(JSON.stringify(bodies.at(-1))).toContain("Finish the original fixture task.");
		expect(JSON.stringify(bodies.at(-1))).toContain("Check completed tool results");
		expect(sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "magpie-auto-continue")).toHaveLength(1);
		expect(statuses.has("magpie-quota")).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}, 15_000);
