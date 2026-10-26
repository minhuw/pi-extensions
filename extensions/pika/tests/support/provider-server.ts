import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedToolCall { id?: string; name: string; arguments: Record<string, unknown> }
/** A reply's text, its tool calls, or both. */
export type ScriptedReply = string | { text?: string; toolCalls?: ScriptedToolCall[] };
/** Picks the reply to a request from its parsed body; undefined falls back to `reply <n>`. */
export type Responder = (body: Record<string, unknown>, index: number) => ScriptedReply | undefined;

/** An OpenAI chat-completions endpoint that records each raw request body and streams a text or tool-call reply. */
export class MockProvider {
	readonly bodies: string[] = [];
	/** The completion id of each reply, in the order of `bodies`; Pi stores it as the assistant message's `responseId`. */
	readonly responseIds: string[] = [];
	/** Send the first chunk of each reply and keep the stream open. */
	hold = false;
	respond?: Responder;
	private server?: Server;
	private count = 0;
	port = 0;

	get baseUrl(): string { return `http://127.0.0.1:${this.port}/v1`; }

	async start(): Promise<this> {
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				const index = this.bodies.length;
				this.bodies.push(raw);
				const id = `chatcmpl-${++this.count}`;
				this.responseIds.push(id);
				let reply: ScriptedReply | undefined;
				try { reply = this.respond?.(JSON.parse(raw) as Record<string, unknown>, index); } catch (error) { reply = `responder failed: ${(error as Error).message}`; }
				const { text, toolCalls = [] } = typeof reply === "string" ? { text: reply } : reply ?? { text: `reply ${this.count}` };
				const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) =>
					`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(chunk({ role: "assistant", content: text ?? "" }, null));
				if (this.hold) return;
				toolCalls.forEach((call, position) => {
					response.write(chunk({
						tool_calls: [{ index: position, id: call.id ?? `call_${this.count}_${position}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
					}, null));
				});
				response.write(chunk({}, toolCalls.length ? "tool_calls" : "stop", { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
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
