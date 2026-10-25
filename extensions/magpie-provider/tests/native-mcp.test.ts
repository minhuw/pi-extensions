import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import magpie from "../index.ts";
import { magpieServer } from "./helpers/magpie-server.ts";

it("saved login activates native search/fetch in the same session without an MCP file; logout withdraws them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "magpie-native-mcp-"));
	const server = await magpieServer("/mcp/magpie/web-search");
	const origin = new URL(server.url).origin;
	const apiKey = "literal-${SHOULD_NOT_EXPAND}";
	const realFetch = globalThis.fetch;
	let session: AgentSession | undefined;
	try {
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("MAGPIE_BASE_URL", origin);
		vi.stubEnv("MAGPIE_API_KEY", "ambient-unused");
		vi.stubEnv("SHOULD_NOT_EXPAND", "wrong-key");
		vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(input) === `${origin}/v1/models`) return Response.json({ data: [{ id: "test" }] });
			return realFetch(input, init);
		}));
		const credentials = new InMemoryCredentialStore();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ api: "openai-responses", provider: "test", models: [{ id: "test" }] });
		const resources = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [async pi => { await magpie(pi); pi.registerProvider(faux.provider); }, createMcpExtension({
				loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }), logPath: join(directory, "mcp.log"),
			})],
		});
		await resources.reload();
		expect(resources.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources,
			sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
		}));
		await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
		expect(server.requests).toEqual([]);
		await runtime.login("magpie", "api_key", {
			prompt: vi.fn().mockResolvedValueOnce(origin).mockResolvedValueOnce(apiKey), notify: vi.fn(),
		});
		const tools = ["mcp__magpie_web_search__web_search", "mcp__magpie_web_search__web_fetch"];
		faux.setResponses([
			context => {
				expect(getCurrentTools(context.messages).filter(tool => tool.name.startsWith("mcp__")).map(tool => tool.name).sort()).toEqual([...tools].sort());
				return fauxAssistantMessage([fauxToolCall(tools[0]!, { query: "fixture search" })]);
			},
			fauxAssistantMessage([fauxToolCall(tools[1]!, { url: "https://example.com" })]),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("Search and fetch the fixture");
		expect(server.requests.filter(request => request.rpc === "tools/call").map(request => request.params?.name)).toEqual(["web_search", "web_fetch"]);
		expect(server.requests.length).toBeGreaterThan(0);
		expect(server.requests.every(request => request.headers.authorization === `Bearer ${apiKey}`)).toBe(true);
		await expect(readFile(join(directory, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await runtime.logout("magpie");
		faux.setResponses([context => {
			expect(getCurrentTools(context.messages).some(tool => tool.name.startsWith("mcp__"))).toBe(false);
			return fauxAssistantMessage("logged out");
		}]);
		await session.prompt("Confirm search tools were withdrawn");
		expect(resources.getExtensions().runtime.mcpServers.list()).toEqual([]);
	} finally {
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
		} finally {
			await server.close();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	}
}, 15_000);
