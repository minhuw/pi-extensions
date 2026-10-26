import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitPayload } from "../blocks.ts";
import { SessionCapture } from "../capture.ts";
import pikaExtension, { CHILD_SESSION_HOOKS, type ChildSessionHook } from "../index.ts";
import { currentUploader, releaseUploader, Uploader } from "../uploader.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { MockProvider } from "./support/provider-server.ts";
import { exitedPid, readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

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
	for (const method of ["onContext", "onPayload", "onAssistantStart", "onAssistant", "settle"] as const) {
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

/** What a crash leaves: the spool on disk, held by a process that has exited, and none of pika's process state. */
async function simulateCrash(): Promise<void> {
	const uploader = currentUploader();
	if (uploader) await releaseUploader(uploader);
	const global = globalThis as Record<symbol, unknown>;
	delete global[Symbol.for("pi-extensions.pika")];
	const hooks = global[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined;
	for (const hook of hooks ?? []) if (hook.name === "pika") hooks!.delete(hook);
	const dir = join(workspace.pikaDir, "spool", "requests");
	const pid = exitedPid();
	for (const name of await readdir(dir)) {
		if (!name.endsWith(".json")) continue;
		const record = JSON.parse(await readFile(join(dir, name), "utf8")) as { awaiting?: object };
		if (record.awaiting) await writeFile(join(dir, name), JSON.stringify({ ...record, awaiting: { ...record.awaiting, pid } }));
	}
}

it("spools a payload when the provider request starts, so a crash mid-stream still delivers it", async () => {
	const provider = await new MockProvider().start();
	provider.hold = true;
	await workspace.enable(ingest.url);
	const first = await startSession({ workspace, extensions: [pikaExtension], openAiBaseUrl: provider.baseUrl });
	const id = first.session.sessionId;
	const prompt = first.session.prompt("a long answer").catch(() => undefined);
	try {
		await waitFor(() => provider.bodies.length === 1, 5_000, "the provider request");
		const spooled = async () => (await readdir(join(workspace.pikaDir, "spool", "requests"))).filter((name) => name.endsWith(".json"));
		await waitFor(async () => (await spooled()).length === 1, 2_000, "the spooled request");
		// Held for its assistant message while the stream is open.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(ingest.sessionRequests(id)).toEqual([]);

		await simulateCrash();
		const second = await startSession({ workspace, faux: first.faux, extensions: [pikaExtension] });
		try {
			await waitFor(() => ingest.sessionRequests(id).length === 1, 5_000, "the request after the restart");
			const [request] = ingest.sessionRequests(id);
			expect(request).toMatchObject({ fidelity: "payload", seq: 1, provider: "pika-mock-openai", model: "mock-model" });
			expect(request!.assistant).toBeUndefined();
			expect(ingest.payload(request!.id)).toEqual(JSON.parse(provider.bodies[0]!));
			await waitFor(async () => (await spooled()).length === 0, 2_000, "an empty spool");
		} finally { await second.shutdown(); }
	} finally {
		await provider.stop();
		await prompt;
		await first.shutdown();
	}
}, 20_000);

it("spools a context-fidelity call when its response starts, so a crash mid-stream still delivers it", async () => {
	await workspace.enable(ingest.url);
	const faux = fauxProvider({ api: "pika-slow-api", provider: "pika-slow", models: [{ id: "test" }], tokensPerSecond: 2 });
	faux.setResponses([fauxAssistantMessage("a slow answer ".repeat(50))]);
	const first = await startSession({ workspace, faux, extensions: [pikaExtension] });
	const id = first.session.sessionId;
	const started = new Promise<void>((resolve) => first.session.subscribe((event) => { if (event.type === "message_start" && event.message.role === "assistant") resolve(); }));
	const prompt = first.session.prompt("a long answer").catch(() => undefined);
	try {
		await started;
		const spooled = async () => (await readdir(join(workspace.pikaDir, "spool", "requests")).catch(() => [])).filter((name) => name.endsWith(".json"));
		await waitFor(async () => (await spooled()).length === 1, 2_000, "the spooled context request");
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(ingest.sessionRequests(id)).toEqual([]);

		await simulateCrash();
		const second = await startSession({ workspace, extensions: [pikaExtension] });
		try {
			await waitFor(() => ingest.sessionRequests(id).length === 1, 5_000, "the request after the restart");
			const [request] = ingest.sessionRequests(id);
			expect(request).toMatchObject({ fidelity: "context", seq: 1, provider: "pika-slow", model: "test" });
			expect(request!.assistant).toBeUndefined();
			const sent = ingest.payload(request!.id) as { messages: { role: string }[] };
			expect(sent.messages[0]!.role).toBe("system");
			expect(JSON.stringify(sent.messages)).toContain("a long answer");
			await waitFor(async () => (await spooled()).length === 0, 2_000, "an empty spool");
		} finally { await second.shutdown(); }
	} finally {
		first.session.abort();
		await prompt;
		await first.shutdown();
	}
}, 20_000);

it("replaces a spooled context call with the payload that arrives after it, under the same id", async () => {
	await workspace.enable(ingest.url);
	const uploader = new Uploader({ url: ingest.url, token: TOKEN, dir: workspace.pikaDir });
	try {
		const session = new SessionCapture("s1", "session:s1", () => uploader, {});
		session.onContext([{ role: "user", content: "hello" }], { provider: "p", model: "m" });
		// A provider that starts its response before it exposes the payload.
		session.onAssistantStart({ role: "assistant", timestamp: 1 });
		session.onPayload({ model: "m", messages: [{ role: "user", content: "hello" }] }, { provider: "p", model: "m" });
		session.onAssistant({ role: "assistant", timestamp: 5, responseId: "r1" });
		await waitFor(() => ingest.sessionRequests("s1").length === 1, 5_000, "the request");
		await uploader.flush();
		const requests = ingest.sessionRequests("s1");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ fidelity: "payload", seq: 1, assistant: { timestamp: 5, responseId: "r1" } });
		expect(ingest.payload(requests[0]!.id)).toEqual({ model: "m", messages: [{ role: "user", content: "hello" }] });
		await waitFor(async () => (await readdir(join(workspace.pikaDir, "spool", "requests"))).every((name) => !name.endsWith(".json")), 2_000, "an empty spool");
		expect(await spooledBlobs()).toEqual([]);
	} finally { await uploader.stop(); }
}, 20_000);

it("rewrites the spooled payload with its assistant message before uploading it", async () => {
	const provider = await new MockProvider().start();
	provider.hold = true;
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension], openAiBaseUrl: provider.baseUrl });
	try {
		const prompt = h.session.prompt("question");
		await waitFor(() => provider.bodies.length === 1, 5_000, "the provider request");
		const [name] = (await readdir(join(workspace.pikaDir, "spool", "requests"))).filter((file) => file.endsWith(".json"));
		expect(name).toBeDefined();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(ingest.sessionRequests(h.session.sessionId)).toEqual([]);
		provider.hold = false;
		await provider.stop();
		await prompt.catch(() => undefined);
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 1, 5_000, "the request");
		const [message] = await assistants(h.session.sessionFile!);
		expect(ingest.sessionRequests(h.session.sessionId)[0]).toMatchObject({ id: name!.replace(/\.json$/, ""), assistant: { timestamp: message.timestamp } });
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); await provider.stop(); }
}, 20_000);

const reconstructs = (server: MockIngest, id: string) => { try { server.payload(id); return true; } catch { return false; } };
const spooledBlobs = async () => (await readdir(join(workspace.pikaDir, "spool", "blobs"))).filter((name) => !name.endsWith(".tmp"));

it("resends previously acknowledged blocks when the client points at a fresh server", async () => {
	const provider = await new MockProvider().start();
	await workspace.enable(ingest.url);
	const first = await startSession({ workspace, extensions: [noop, pikaExtension], tools: ["noop"], openAiBaseUrl: provider.baseUrl });
	try {
		await first.session.prompt("same question");
		await waitFor(() => ingest.sessionRequests(first.session.sessionId).length === 1, 5_000, "first request");
	} finally { await first.shutdown(); }

	const fresh = await new MockIngest().start();
	try {
		await workspace.enable(fresh.url);
		const second = await startSession({ workspace, extensions: [noop, pikaExtension], tools: ["noop"], openAiBaseUrl: provider.baseUrl });
		try {
			await second.session.prompt("same question");
			await waitFor(() => fresh.sessionRequests(second.session.sessionId).length === 1, 5_000, "request on the fresh server");
			const [request] = fresh.sessionRequests(second.session.sessionId);
			// The tool declaration, at least, was acknowledged by the first server.
			expect(request!.blocks.filter((hash) => ingest.blobs.has(hash)).length).toBeGreaterThan(0);
			await waitFor(() => reconstructs(fresh, request!.id), 5_000, "every block on the fresh server");
			expect(fresh.payload(request!.id)).toEqual(JSON.parse(provider.bodies[1]!));
			// Acknowledgements from the first server do not count: the blocks went out with the first send.
			expect(fresh.requestReceipts.get(request!.id)).toBe(1);
		} finally { await second.shutdown(); }
	} finally { await fresh.stop(); await provider.stop(); }
}, 20_000);

it("answers missingBlobs when the server lost acknowledged blocks, and then deletes the spooled blocks", async () => {
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		h.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await h.session.prompt("first");
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 1, 5_000, "first request");
		await waitFor(async () => (await spooledBlobs()).length === 0, 2_000, "no spooled blocks once the request is complete");
		ingest.blobs.clear();

		await h.session.prompt("second");
		await waitFor(() => ingest.sessionRequests(h.session.sessionId).length === 2, 5_000, "second request");
		const second = ingest.sessionRequests(h.session.sessionId)[1]!;
		await waitFor(() => reconstructs(ingest, second.id), 5_000, "the lost blocks resent");
		expect(ingest.requestReceipts.get(second.id)).toBe(2);
		await waitFor(async () => (await spooledBlobs()).length === 0, 2_000, "no spooled blocks");
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}, 20_000);
