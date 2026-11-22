import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../catalog-pricing.ts", async importOriginal => ({ ...await importOriginal<object>(), loadModelsDevPricing: async () => undefined }));
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createMcpExtension, type AgentSession } from "@earendil-works/pi-coding-agent";
import magpie from "../index.ts";
import { createMagpieTestSession } from "./helpers/session.ts";

/** Loopback-only Streamable HTTP fixture. Production always uses Pi's native MCP transport. */
async function magpieServer(endpoint = "/mcp") {
	const requests: { method: string; path: string; headers: IncomingHttpHeaders; rpc?: string; params?: Record<string, unknown> }[] = [];
	const tools = ["web_search", "web_fetch", "unexpected_tool"];
	const server = createServer(async (req, res) => {
		const request: typeof requests[number] = { method: req.method!, path: req.url!, headers: req.headers };
		requests.push(request);
		if (req.url !== endpoint) { res.writeHead(404).end(); return; }
		if (req.method === "DELETE") { res.writeHead(200).end(); return; }
		if (req.method !== "POST") { res.writeHead(405).end(); return; }
		let text = "";
		for await (const chunk of req) text += chunk;
		const body = JSON.parse(text) as { id?: string | number; method: string; params?: Record<string, unknown> };
		request.rpc = body.method;
		request.params = body.params;
		if (body.id === undefined) { res.writeHead(202).end(); return; }
		const respond = (result: unknown) => {
			res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "fixture-session" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
		};
		switch (body.method) {
			case "initialize":
				respond({ protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "magpie-fixture", version: "1" } });
				break;
			case "tools/list":
				respond({ tools: tools.map((name) => ({ name, description: name, inputSchema: {
					type: "object", properties: name === "web_fetch" ? { url: { type: "string" } } : { query: { type: "string" } },
				} })) });
				break;
			case "resources/list": respond({ resources: [] }); break;
			case "resources/templates/list": respond({ resourceTemplates: [] }); break;
			case "tools/call": respond({ content: [{ type: "text", text: `fixture ${body.params?.name}` }] }); break;
			default: respond({});
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
	return {
		url: `http://127.0.0.1:${address.port}${endpoint}`,
		requests,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}

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
		const faux = fauxProvider({ api: "openai-responses", provider: "test", models: [{ id: "test" }] });
		const { session: createdSession, modelRuntime: runtime, resourceLoader: resources } = await createMagpieTestSession({
			cwd: directory,
			agentDir: directory,
			model: faux.getModel("test")!,
			settings: { defaultTools: [] },
			extensionFactories: [async pi => { await magpie(pi); pi.registerProvider(faux.provider); }, createMcpExtension({
				loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }), logPath: join(directory, "mcp.log"),
			})],
		});
		session = createdSession;
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
