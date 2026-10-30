import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createMagpieProvider } from "../index.ts";

const delegates = vi.hoisted(() => ({ stream: vi.fn(), streamSimple: vi.fn() }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
	builtinProviders: () => ["groq", "openai", "anthropic"].map(id => ({ id, getModels: () => [], ...delegates })),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const usage = () => ({ input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

it("retries a local Claude alias after Pi records an unmarked request failure", async () => {
	const physicalId = "claude1/claude-opus-5-5";
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{
		id: physicalId, owned_by: "claude1", native_endpoints: ["/v1/messages"],
	}] })));
	const provider = createMagpieProvider({ MAGPIE_BASE_URL: "http://127.0.0.1:3425", MAGPIE_API_KEY: "fixture-key" });
	await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
		publish: async ({ update }) => { update?.(); return true; },
	});
	const alias = provider.getModels().find(model => model.id === "claude-opus-5-5")!;
	let attempts = 0;
	delegates.streamSimple.mockImplementation((model: Model<any>) => {
		expect(model.id).toBe(physicalId);
		if (++attempts === 1) throw new Error("This operation was aborted");
		const message: AssistantMessage = { role: "assistant", provider: "magpie", model: model.id, api: model.api,
			content: [{ type: "text", text: "recovered" }], timestamp: Date.now(), usage: usage(), stopReason: "stop" };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	const agent = new Agent({ initialState: { model: alias }, streamFn: (model, context, options) => {
		expect(model).toBe(alias);
		return provider.streamSimple!(alias, context, options);
	} });
	await agent.prompt("First attempt.");
	const failed = agent.state.messages.findLast(message => message.role === "assistant");
	expect(failed).toMatchObject({ model: alias.id, stopReason: "error", errorMessage: "This operation was aborted" });
	expect(failed).not.toHaveProperty("magpiePhysicalModel");
	await agent.prompt("Retry.");
	expect(attempts).toBe(2);
	expect(agent.state.messages.findLast(message => message.role === "assistant")).toMatchObject({
		model: alias.id, magpiePhysicalModel: physicalId, stopReason: "stop", content: [{ type: "text", text: "recovered" }],
	});
});

it.each(["overflow", "length"] as const)("Pi automatically compacts and retries a local Claude alias after %s", async failure => {
	const directory = mkdtempSync(join(tmpdir(), "magpie-alias-recovery-"));
	let session: AgentSession | undefined;
	try {
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		vi.stubEnv("PI_OFFLINE", "1");
		const physicalId = "claude1/claude-opus-5-5";
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{
			id: physicalId, owned_by: "claude1", native_endpoints: ["/v1/messages"], context_window: 8192, max_output_tokens: 256,
		}] })));
		const provider = createMagpieProvider({ MAGPIE_BASE_URL: "http://127.0.0.1:3425", MAGPIE_API_KEY: "fixture-key" });
		await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
			publish: async ({ update }) => { update?.(); return true; },
		});
		const alias = provider.getModels().find(model => model.id === "claude-opus-5-5")!;
		expect(alias).toBeDefined();
		let attempts = 0;
		const respond = (model: Model<any>) => {
			expect(model.id).toBe(physicalId);
			attempts++;
			const first = attempts === 1;
			const message: AssistantMessage = { role: "assistant", provider: "magpie", model: model.id, api: model.api,
				content: [{ type: "text", text: first ? "incomplete" : "recovered" }], timestamp: Date.now(), usage: usage(),
				stopReason: first ? failure === "overflow" ? "error" : "length" : "stop",
				...(first && failure === "overflow" ? { errorMessage: "maximum context length exceeded" } : {}),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: message.stopReason as "length" | "stop", message });
			return stream;
		};
		delegates.stream.mockImplementation(respond);
		delegates.streamSimple.mockImplementation(respond);
		const compact = vi.fn();
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
		const resources = new DefaultResourceLoader({ cwd: directory, agentDir: directory,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => {
				pi.registerProvider(provider);
				pi.on("session_before_compact", event => {
					compact(event.reason, event.willRetry);
					return { compaction: { summary: "Fixture compaction summary.",
						firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
					} };
				});
			}],
		});
		await resources.reload();
		expect(resources.getExtensions().errors).toEqual([]);
		const history = SessionManager.inMemory(directory);
		history.appendModelChange("magpie", alias.id);
		history.appendMessage({ role: "user", content: "Earlier question. ".repeat(100), timestamp: 0 });
		history.appendMessage({ role: "assistant", provider: "magpie", model: alias.id, api: alias.api,
			magpiePhysicalModel: physicalId, content: [{ type: "text", text: "Earlier answer. ".repeat(100) }],
			stopReason: "stop", usage: usage(), timestamp: 1,
		} as AssistantMessage);
		({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
			model: alias, resourceLoader: resources, sessionManager: history,
			settingsManager: SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 }, retry: { enabled: false } }),
		}));
		await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await session.prompt("Continue the fixture conversation.");
		expect(attempts).toBe(2);
		expect(compact).toHaveBeenCalledWith("overflow", true);
		expect(events).toContainEqual(expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: true, aborted: false }));
		const last = session.agent.state.messages.findLast(message => message.role === "assistant");
		expect(last).toMatchObject({ model: alias.id, magpiePhysicalModel: physicalId, stopReason: "stop", content: [{ type: "text", text: "recovered" }] });
		expect(JSON.parse(JSON.stringify(last))).toMatchObject({ model: alias.id, magpiePhysicalModel: physicalId });
	} finally {
		session?.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}, 15_000);
