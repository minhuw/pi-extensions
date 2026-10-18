import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

/** Loopback-only Streamable HTTP fixture. Production always uses Pi's native MCP transport. */
export async function magpieServer(endpoint = "/mcp") {
	const requests: { method: string; path: string; headers: IncomingHttpHeaders; rpc?: string; params?: Record<string, unknown> }[] = [];
	let tools = ["web_search", "web_fetch", "unexpected_tool"];
	const descriptions = new Map<string, unknown>();
	let logMessage: string | undefined;
	let failure: "initialize" | "tools/list" | undefined;
	let holdCalls = false;
	let callStarted: (() => void) | undefined;
	let callClosed: (() => void) | undefined;
	let discoveryStarted: (() => void) | undefined;
	let discoveryGate: Promise<void> | undefined;
	let releaseDiscovery: (() => void) | undefined;
	let initializeCount = 0;
	let retryInitializationStarted: (() => void) | undefined;
	let retryInitializationClosed: (() => void) | undefined;
	let retryInitializationResponse: ServerResponse | undefined;
	const pending = new Set<ServerResponse>();
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
			const response = { jsonrpc: "2.0", id: body.id, result };
			res.end(JSON.stringify(logMessage && body.method === "tools/list" ? [
				{ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: logMessage } },
				response,
			] : response));
		};
		if (body.method === failure) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "fixture failure" } }));
			return;
		}
		switch (body.method) {
			case "initialize":
				initializeCount++;
				if (initializeCount > 1 && retryInitializationStarted) {
					retryInitializationResponse = res;
					pending.add(res);
					res.on("close", () => { pending.delete(res); retryInitializationClosed?.(); });
					retryInitializationStarted();
					break;
				}
				respond({ protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "magpie-fixture", version: "1" } });
				break;
			case "tools/list":
				discoveryStarted?.();
				await discoveryGate;
				respond({ tools: tools.map((name) => ({ name, description: descriptions.has(name) ? descriptions.get(name) : name, inputSchema: {
					type: "object", properties: name === "web_fetch" ? { url: { type: "string" } } : { query: { type: "string" } },
				} })) });
				break;
			case "resources/list": respond({ resources: [] }); break;
			case "resources/templates/list": respond({ resourceTemplates: [] }); break;
			case "tools/call":
				callStarted?.();
				if (holdCalls) {
					pending.add(res);
					res.on("close", () => { pending.delete(res); callClosed?.(); });
				} else respond({ content: [{ type: "text", text: `fixture ${body.params?.name}` }] });
				break;
			default: respond({});
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
	return {
		url: `http://127.0.0.1:${address.port}${endpoint}`, requests,
		setTools(value: string[]) { tools = value; },
		setToolDescription(name: string, value: unknown) { descriptions.set(name, value); },
		setLogMessage(value: string) { logMessage = value; },
		setFailure(value: typeof failure) { failure = value; },
		holdDiscovery() {
			discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
			return { started: new Promise<void>((resolve) => { discoveryStarted = resolve; }), release: () => releaseDiscovery?.() };
		},
		holdRetryInitialization() {
			return {
				started: new Promise<void>((resolve) => { retryInitializationStarted = resolve; }),
				closed: new Promise<void>((resolve) => { retryInitializationClosed = resolve; }),
				cancel: () => retryInitializationResponse?.destroy(),
			};
		},
		holdCalls() {
			holdCalls = true;
			return {
				started: new Promise<void>((resolve) => { callStarted = resolve; }),
				closed: new Promise<void>((resolve) => { callClosed = resolve; }),
			};
		},
		async close() {
			releaseDiscovery?.();
			for (const res of pending) res.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}
