import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** An OpenAI chat-completions endpoint that records each raw request body and streams a text reply. */
export class MockProvider {
	readonly bodies: string[] = [];
	private server?: Server;
	private count = 0;
	port = 0;

	get baseUrl(): string { return `http://127.0.0.1:${this.port}/v1`; }

	async start(): Promise<this> {
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				this.bodies.push(Buffer.concat(chunks).toString("utf8"));
				const id = `chatcmpl-${++this.count}`;
				const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) =>
					`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(chunk({ role: "assistant", content: `reply ${this.count}` }, null));
				response.write(chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		this.port = (server.address() as AddressInfo).port;
		this.server = server;
		return this;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		server?.closeAllConnections();
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
