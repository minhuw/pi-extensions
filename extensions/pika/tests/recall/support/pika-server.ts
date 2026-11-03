import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export const TOKEN = "recall-test-token";

export interface Recorded { method: string; path: string; query: URLSearchParams; authorization?: string }
export interface Answer { status?: number; body?: unknown; delayMs?: number }
type Route = Answer | ((request: Recorded) => Answer);

/**
 * An in-memory pika server: `/api/health` with `features`, and the agent read API's routes as the
 * test sets them, by path under `/api/agent/v1/`. It checks the bearer token and read access as
 * pika does; an unset route answers 404 `not_found`, as pika does for an unknown session.
 */
export class FakePika {
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	url = "";
	/** `["relay"]` answers health like a pika server without the agent read API. */
	features: string[] = ["relay", "agent"];
	readonly tokens = new Set([TOKEN]);
	readAccess = true;
	/** Without the agent API, every agent path is unknown. */
	get agent() { return this.features.includes("agent"); }
	readonly routes = new Map<string, Route>();
	/** Every agent API request, in order. */
	readonly requests: Recorded[] = [];

	async start(base = ""): Promise<this> {
		this.server = createServer((request, response) => { void this.handle(request, response, base); });
		this.server.on("connection", (socket) => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${base}`;
		return this;
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
	}

	/** The agent requests to a path, without the `/api/agent/v1/` prefix. */
	requestsTo(path: string): Recorded[] { return this.requests.filter((request) => request.path === path); }

	private async handle(request: IncomingMessage, response: ServerResponse, base: string): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname.slice(base.length);
		const json = (status: number, body: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			response.end(JSON.stringify(body));
		};
		if (path === "/api/health") { json(200, { ok: true, features: this.features }); return; }
		if (!path.startsWith("/api/agent/v1/") || !this.agent) { json(404, { error: "not_found" }); return; }
		const recorded: Recorded = { method: request.method ?? "GET", path: path.slice("/api/agent/v1/".length), query: url.searchParams, authorization: request.headers.authorization };
		this.requests.push(recorded);
		const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
		if (!token || !this.tokens.has(token)) { json(401, { error: "unauthorized" }); return; }
		if (!this.readAccess) { json(403, { error: "read_access_denied" }); return; }
		const route = this.routes.get(recorded.path);
		const answer = typeof route === "function" ? route(recorded) : route;
		if (!answer) { json(404, { error: "not_found" }); return; }
		if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
		if (response.destroyed) return;
		json(answer.status ?? 200, answer.body ?? {});
	}
}
