import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitPayload } from "../blocks.ts";
import { SessionCapture } from "../capture.ts";
import pikaExtension from "../index.ts";
import { currentUploader, Uploader } from "../uploader.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { MockProvider } from "./support/provider-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => { vi.restoreAllMocks(); await ingest.stop(); await workspace.cleanup(); });

const assistants = (file: string) => readText(file).then((text) => text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>)
	.filter((entry) => entry.type === "message" && entry.message.role === "assistant").map((entry) => entry.message));

it("records the payload the provider received, after earlier extensions changed it, linked to its assistant message", async () => {
	const provider = await new MockProvider().start();
	await workspace.enable(ingest.url);
	const modify = (pi: ExtensionAPI) => {
		pi.on("before_provider_request", (event) => ({ ...(event.payload as object), metadata: { pika: "modified" }, pika_long: "y".repeat(3000) }));
	};
	const h = await startSession({ workspace, extensions: [modify, pikaExtension], openAiBaseUrl: provider.baseUrl });
	try {
		await h.session.prompt("first question");
		await h.session.prompt("second question");
		expect(provider.bodies).toHaveLength(2);
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 2, 5_000, "two requests");
		const requests = ingest.sessionRequests(h.session.sessionId);
		const messages = await assistants(h.session.sessionFile!);
		for (const [index, request] of requests.entries()) {
			expect(request.fidelity).toBe("payload");
			const sent = JSON.parse(provider.bodies[index]!);
			expect(sent).toMatchObject({ metadata: { pika: "modified" } });
			expect(ingest.payload(request.id)).toEqual(sent);
			expect(request.assistant).toEqual({ timestamp: messages[index].timestamp, responseId: `chatcmpl-${index + 1}` });
			expect(request).toMatchObject({ seq: index + 1, provider: "pika-mock-openai", api: "openai-completions", model: "mock-model" });
			expect(request.skeleton).toMatchObject({ pika_long: { $pika: expect.any(String), $type: "string" } });
		}
		// The second request shares the first one's messages, so those blocks are sent once.
		const sentBlobs = ingest.bodies.flatMap((body) => body.blobs ?? []).map((blob) => blob.hash);
		expect(new Set(sentBlobs).size).toBe(sentBlobs.length);
		expect(requests[0]!.blocks.some((hash) => requests[1]!.blocks.includes(hash))).toBe(true);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); await provider.stop(); }
}, 20_000);

it("records the pi context with fidelity context, including the system message, when no payload is exposed", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("from faux")]);
		await h.session.prompt("what do you see?");
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 1, 5_000, "one request");
		const [request] = ingest.sessionRequests(h.session.sessionId);
		expect(request!.fidelity).toBe("context");
		const payload = ingest.payload(request!.id) as { messages: { role: string; content: unknown }[] };
		expect(payload.messages[0]!.role).toBe("system");
		expect(JSON.stringify(payload.messages.find((message) => message.role === "user"))).toContain("what do you see?");
		const [assistant] = await assistants(h.session.sessionFile!);
		expect(request!.assistant).toMatchObject({ timestamp: assistant.timestamp });
		expect(request).toMatchObject({ provider: "pika-test", model: "test" });
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

const noop = (pi: ExtensionAPI) => {
	pi.registerTool({ name: "noop", label: "noop", description: "Does nothing", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
};

it("records one request per model call, and a payload without an assistant message keeps no assistant field", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [noop, pikaExtension], tools: ["noop"] });
	try {
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("noop", {})]), fauxAssistantMessage("done")]);
		await h.session.prompt("call a tool");
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 2, 5_000, "two requests");
		const messages = await assistants(h.session.sessionFile!);
		expect(ingest.sessionRequests(h.session.sessionId).map((request) => request.assistant?.timestamp)).toEqual(messages.map((message) => message.timestamp));

		// A side request, such as a compaction, that never produces an assistant message.
		await h.session.extensionRunner.emitBeforeProviderRequest({ model: "side", messages: [{ role: "user", content: "summarize" }] });
		h.faux.appendResponses([fauxAssistantMessage("after")]);
		await h.session.prompt("after the side request");
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 4, 5_000, "four requests");
		const requests = ingest.sessionRequests(h.session.sessionId);
		const side = requests.find((request) => (ingest.payload(request.id) as { model?: string }).model === "side")!;
		expect(side).toMatchObject({ fidelity: "payload", seq: 3 });
		expect(side.assistant).toBeUndefined();
		expect(requests[3]).toMatchObject({ fidelity: "context", seq: 4, assistant: { timestamp: (await assistants(h.session.sessionFile!)).at(-1).timestamp } });
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);

it("never blocks a turn when the server accepts connections but never answers", async () => {
	ingest.mode = "hang";
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [noop, pikaExtension], tools: ["noop"] });
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {})]), fauxAssistantMessage([fauxToolCall("noop", {})]), fauxAssistantMessage("done"),
		]);
		await h.session.prompt("warm up");
		const started = Date.now();
		h.faux.appendResponses([fauxAssistantMessage([fauxToolCall("noop", {})]), fauxAssistantMessage("done again")]);
		await h.session.prompt("use the tool");
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(h.faux.state.callCount).toBe(5);
		expect(ingest.responses).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally {
		const started = Date.now();
		await h.shutdown();
		// session_shutdown waits at most 2 s for the hanging server.
		expect(Date.now() - started).toBeLessThan(3_000);
	}
	// Nothing is lost: the requests stay spooled for the next start.
	expect((await readdir(join(workspace.pikaDir, "spool", "requests"))).filter((name) => name.endsWith(".json"))).toHaveLength(5);
}, 20_000);

it("does not fail a turn when pika's internals throw", async () => {
	await workspace.enable(ingest.url);
	for (const method of ["onContext", "onPayload", "onAssistant", "settle"] as const) {
		vi.spyOn(SessionCapture.prototype, method).mockImplementation(() => { throw new Error(`simulated ${method} failure`); });
	}
	vi.spyOn(Uploader.prototype, "poke").mockImplementation(() => { throw new Error("simulated poke failure"); });
	const h = await startSession({ workspace, extensions: [noop, pikaExtension], tools: ["noop"] });
	try {
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("noop", {})]), fauxAssistantMessage("still fine")]);
		await h.session.prompt("hello");
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(h.errors).toEqual([]);
		expect(currentUploader()!.status().lastError).toMatch(/simulated/);
	} finally { await h.shutdown(); }
	// Shutdown still releases everything.
	expect(currentUploader()).toBeUndefined();
}, 20_000);

it("splits payloads by the spec's block rules", () => {
	const payload = { model: "m", messages: [{ role: "user", content: "a" }, { role: "user", content: "a" }], tools: [], instructions: "z".repeat(2049), short: "z".repeat(2048), n: 1 };
	const split = splitPayload(payload);
	expect(split.skeleton).toMatchObject({ model: "m", short: payload.short, n: 1, tools: [], instructions: { $type: "string" } });
	const messages = (split.skeleton as { messages: { $pika: string }[] }).messages;
	expect(messages[0]!.$pika).toBe(messages[1]!.$pika);
	expect(split.blocks).toHaveLength(2);
	expect(split.data.get(messages[0]!.$pika)).toBe(JSON.stringify(payload.messages[0]));
});
