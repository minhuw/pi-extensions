import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession, ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAgentRunner, modelRuntimeOf, type PiRunnerOptions } from "../../src/agents/session.ts";
import { AgentError, type AgentRunRequest, type ErrorClass, type OutputStore } from "../../src/types.ts";
import { fakeRole } from "../support/fake-runner.ts";

let dir: string;
let cwd: string;
let runtime: ModelRuntime;
let faux: FauxProviderHandle;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "herder-agents-"));
	cwd = join(dir, "wt");
	mkdirSync(cwd);
	mkdirSync(join(dir, "agent"));
	runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	faux = fauxProvider({ api: "herder-faux-api", provider: "herder-faux", models: [{ id: "main", reasoning: true }, { id: "other", reasoning: true }] });
	runtime.registerNativeProvider(faux.provider);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runner(options: Partial<PiRunnerOptions> = {}) {
	return createPiAgentRunner({
		modelRuntime: runtime, agentDir: join(dir, "agent"), inheritModel: () => faux.getModel("main"), inheritThinking: () => "low",
		settings: () => SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), ...options,
	});
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
	return { role: fakeRole("worker"), prompt: "do the task", cwd, signal: new AbortController().signal, timeoutMs: 10_000, stallMs: 10_000, ...overrides };
}

const toolNames = (context: Parameters<Extract<FauxResponseStep, Function>>[0]) => getCurrentTools(context.messages).map((tool) => tool.name).sort();

async function rejection(promise: Promise<unknown>): Promise<AgentError> {
	const error = await promise.then(() => undefined, (failure: unknown) => failure);
	expect(error).toBeInstanceOf(AgentError);
	return error as AgentError;
}

/** A provider call that streams nothing until its request is aborted. */
const hang: FauxResponseStep = (_context, options) => new Promise((done) => {
	options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
});

describe("Pi agent runner", () => {
	it("returns the final assistant text, usage, events, and a stored transcript", async () => {
		const stored: string[] = [];
		const outputs: OutputStore = { put: (content) => { stored.push(String(content)); return `outputs/${stored.length}.txt`; }, read: () => "" };
		const events: string[] = [];
		faux.setResponses([fauxAssistantMessage("all done")]);
		const result = await runner({ outputs }).run(request({ onEvent: (kind) => events.push(kind) }));
		expect(result.text).toBe("all done");
		expect(result.data).toBeUndefined();
		expect(result.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
		expect(result.usage!.output).toBeGreaterThan(0);
		expect(result.transcriptRef).toBe("outputs/1.txt");
		expect(JSON.parse(stored[0]!).map((message: { role: string }) => message.role).filter((role: string) => role !== "system")).toEqual(["user", "assistant"]);
		expect(events).toContain("agent_start");
		expect(events).toContain("message_end");
	});

	it("restricts tools to the role and removes edit/write from read-only roles", async () => {
		const seen: string[][] = [];
		const record: FauxResponseStep = (context) => { seen.push(toolNames(context)); return fauxAssistantMessage("ok"); };
		faux.setResponses([record, record, (context) => { seen.push(toolNames(context)); return fauxAssistantMessage([fauxToolCall("StructuredOutput", {})]); }, fauxAssistantMessage("ok")]);
		await runner().run(request({ role: fakeRole("worker") }));
		await runner().run(request({ role: { ...fakeRole("reviewer"), tools: ["read", "edit", "write", "grep"] } }));
		await runner().run(request({ role: fakeRole("reviewer"), schema: { type: "object", properties: {} } }));
		expect(seen[0]).toEqual(["bash", "edit", "read", "write"]);
		expect(seen[1]).toEqual(["grep", "read"]);
		expect(seen[2]).toEqual(["StructuredOutput", "bash", "read"]);
	});

	it("never lets a read-only role regain writers through patterns, modifiers, or other tools", async () => {
		const seen: string[][] = [];
		const record: FauxResponseStep = (context) => { seen.push(toolNames(context)); return fauxAssistantMessage("ok"); };
		faux.setResponses([record, record, record, record]);
		for (const tools of [["-bash"], ["*"], ["read", "powershell"], ["read", "+edit", "write"]]) {
			await runner().run(request({ role: { ...fakeRole("reviewer"), tools } }));
		}
		expect(seen).toEqual([[], [], ["read"], ["read"]]);
	});

	it("ignores project settings and installs no packages in the worktree", async () => {
		const record = join(dir, "npm-invoked");
		const npm = join(dir, "fake-npm.mjs");
		writeFileSync(npm, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join(" ") + "\\n");`);
		const settings = { packages: ["npm:herder-test-not-a-package", "git:github.com/example/herder-test"], npmCommand: [process.execPath, npm], retry: { enabled: false }, compaction: { enabled: false } };
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
		writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "PROJECT SYSTEM PROMPT");
		writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify(settings));
		let systemPrompt = "";
		faux.setResponses([(context) => { systemPrompt = getCurrentSystemPrompt(context.messages); return fauxAssistantMessage("ok"); }]);
		await runner({ settings: undefined }).run(request());
		expect(existsSync(record)).toBe(false);
		expect(readdirSync(join(cwd, ".pi")).sort()).toEqual(["SYSTEM.md", "settings.json"]);
		expect(readdirSync(cwd)).toEqual([".pi"]);
		expect(readdirSync(join(dir, "agent")).sort()).toEqual(["settings.json"]);
		expect(systemPrompt).not.toContain("PROJECT SYSTEM PROMPT");
	});

	it("validates structured output and accepts a corrected payload after a bad one", async () => {
		const schema = { type: "object", properties: { verdict: { type: "string", enum: ["pass", "fail"] }, score: { type: "number" } }, required: ["verdict", "score"] };
		let rejectionText = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("StructuredOutput", { verdict: "maybe" })]),
			(context) => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") rejectionText = last.content.map((part) => part.type === "text" ? part.text : "").join("");
				return fauxAssistantMessage([fauxToolCall("StructuredOutput", { verdict: "pass", score: 3 })]);
			},
			fauxAssistantMessage("reported"),
		]);
		const result = await runner().run(request({ schema }));
		expect(result.data).toEqual({ verdict: "pass", score: 3 });
		expect(rejectionText).toMatch(/score|verdict/);
	});

	it("re-prompts an agent that ends without calling StructuredOutput", async () => {
		let reminder = "";
		faux.setResponses([
			fauxAssistantMessage("here is my answer in prose"),
			(context) => {
				const last = context.messages.at(-1);
				if (last?.role === "user") reminder = typeof last.content === "string" ? last.content : last.content.map((part) => part.type === "text" ? part.text : "").join("");
				return fauxAssistantMessage([fauxToolCall("StructuredOutput", { ok: true })]);
			},
			fauxAssistantMessage("done"),
		]);
		const result = await runner().run(request({ schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }));
		expect(result.data).toEqual({ ok: true });
		expect(reminder).toContain("did not call StructuredOutput");
	});

	it("fails with invalid_output after three rejections", async () => {
		const bad = () => fauxAssistantMessage([fauxToolCall("StructuredOutput", { n: "not a number" })]);
		faux.setResponses([bad(), bad(), bad(), fauxAssistantMessage("never reached")]);
		const error = await rejection(runner().run(request({ schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })));
		expect(error.errorClass).toBe("invalid_output");
		expect(faux.state.callCount).toBe(3);
	});

	it("counts prose endings toward the rejection limit", async () => {
		faux.setResponses([fauxAssistantMessage("prose"), fauxAssistantMessage("prose"), fauxAssistantMessage("prose"), fauxAssistantMessage("prose")]);
		const error = await rejection(runner().run(request({ schema: { type: "object", properties: {} } })));
		expect(error.errorClass).toBe("invalid_output");
		expect(faux.state.callCount).toBe(3);
	});

	it("counts a rejected call and the prose ending after it as one attempt", async () => {
		const bad = () => fauxAssistantMessage([fauxToolCall("StructuredOutput", { n: "not a number" })]);
		faux.setResponses([bad(), fauxAssistantMessage("prose"), bad(), fauxAssistantMessage("prose"), fauxAssistantMessage([fauxToolCall("StructuredOutput", { n: 1 })]), fauxAssistantMessage("done")]);
		const result = await runner().run(request({ schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }));
		expect(result.data).toEqual({ n: 1 });
	});

	it("counts several rejected calls in one turn as one attempt", async () => {
		const bad = (id: string) => fauxToolCall("StructuredOutput", { n: "not a number" }, { id });
		faux.setResponses([fauxAssistantMessage([bad("a"), bad("b"), bad("c")]), fauxAssistantMessage([fauxToolCall("StructuredOutput", { n: 2 })]), fauxAssistantMessage("done")]);
		const result = await runner().run(request({ schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }));
		expect(result.data).toEqual({ n: 2 });
	});

	it("does not re-prompt after the watchdog failed", async () => {
		const controller = new AbortController();
		faux.setResponses([fauxAssistantMessage("prose"), fauxAssistantMessage("late"), fauxAssistantMessage("late")]);
		const onEvent = (kind: string) => { if (kind === "agent_end") controller.abort(); };
		const error = await rejection(runner().run(request({ signal: controller.signal, onEvent, schema: { type: "object", properties: {} } })));
		expect(error.message).toBe("aborted");
		await new Promise((done) => setTimeout(done, 100));
		expect(faux.state.callCount).toBe(1);
	});

	it("attaches the transcript to failures when outputs are given", async () => {
		const stored: string[] = [];
		const outputs: OutputStore = { put: (content) => { stored.push(String(content)); return `outputs/${stored.length}.txt`; }, read: () => "" };
		const bad = () => fauxAssistantMessage([fauxToolCall("StructuredOutput", { n: "x" })]);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }), bad(), bad(), bad(), hang, hang]);
		const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
		const provider = await rejection(runner({ outputs }).run(request()));
		const invalid = await rejection(runner({ outputs }).run(request({ schema })));
		const stall = await rejection(runner({ outputs }).run(request({ stallMs: 150 })));
		const controller = new AbortController();
		const run = runner({ outputs }).run(request({ signal: controller.signal }));
		setTimeout(() => controller.abort(), 100);
		const aborted = await rejection(run);
		expect([provider, invalid, stall, aborted].map((error) => [error.errorClass, error.transcriptRef])).toEqual([
			["transient", "outputs/1.txt"], ["invalid_output", "outputs/2.txt"], ["stall", "outputs/3.txt"], ["fatal", "outputs/4.txt"],
		]);
		expect(aborted.message).toBe("aborted");
		expect(JSON.parse(stored[1]!).filter((message: { role: string }) => message.role === "toolResult")).toHaveLength(3);
		expect(JSON.parse(stored[2]!).map((message: { role: string }) => message.role)).toContain("user");
	});

	it("fails with stall when the session emits no events within the stall window", async () => {
		faux.setResponses([hang]);
		const started = Date.now();
		const error = await rejection(runner().run(request({ stallMs: 150, timeoutMs: 10_000 })));
		expect(error.errorClass).toBe("stall");
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("fails with timeout when the attempt exceeds its wall clock while events keep flowing", async () => {
		const slow = fauxProvider({ api: "herder-slow-api", provider: "herder-slow", models: [{ id: "slow" }], tokensPerSecond: 40 });
		runtime.registerNativeProvider(slow.provider);
		slow.setResponses([fauxAssistantMessage("word ".repeat(400))]);
		const events: string[] = [];
		const error = await rejection(runner({ inheritModel: () => slow.getModel("slow") }).run(request({ stallMs: 400, timeoutMs: 700, onEvent: (kind) => events.push(kind) })));
		expect(error.errorClass).toBe("timeout");
		expect(events.filter((kind) => kind === "message_update").length).toBeGreaterThan(3);
	});

	it("treats limits beyond the timer range as that long instead of firing at once", async () => {
		const slow = fauxProvider({ api: "herder-long-api", provider: "herder-long", models: [{ id: "long" }], tokensPerSecond: 40 });
		runtime.registerNativeProvider(slow.provider);
		slow.setResponses([fauxAssistantMessage("word ".repeat(10))]);
		const result = await runner({ inheritModel: () => slow.getModel("long") }).run(request({ timeoutMs: 2 ** 40, stallMs: 2 ** 40 }));
		expect(result.text).toBe("word ".repeat(10).trim());
	});

	it("stops the session promptly when the signal aborts", async () => {
		let providerSignal: AbortSignal | undefined;
		faux.setResponses([(context, options) => { providerSignal = options?.signal; return (hang as Extract<FauxResponseStep, Function>)(context, options, faux.state, faux.getModel()); }]);
		const controller = new AbortController();
		const run = runner().run(request({ signal: controller.signal }));
		await new Promise((done) => setTimeout(done, 100));
		const started = Date.now();
		controller.abort();
		const error = await rejection(run);
		expect(error.errorClass).toBe("fatal");
		expect(error.message).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(providerSignal?.aborted).toBe(true);
	});

	it("rejects an already aborted signal without starting a session", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await rejection(runner().run(request({ signal: controller.signal })));
		expect(error.errorClass).toBe("fatal");
		expect(faux.state.callCount).toBe(0);
	});

	it.each<[string, ErrorClass]>([
		["429 Too Many Requests: rate limit exceeded", "rate_limit"],
		["401 Unauthorized: invalid x-api-key", "auth"],
		["529 overloaded_error", "transient"],
		["You exceeded your current quota, please check your plan and billing details", "usage_limit"],
		["context window exceeded by the request", "fatal"],
	])("classifies a run ending with provider error %j", async (message, errorClass) => {
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: message })]);
		const error = await rejection(runner().run(request()));
		expect(error.errorClass).toBe(errorClass);
		expect(error.message).toBe(message);
	});

	it("resolves inherit, explicit models, inherited thinking, and the effort override", async () => {
		const seen: { model: string; reasoning: unknown }[] = [];
		const record: FauxResponseStep = (_context, options, _state, model) => { seen.push({ model: model.id, reasoning: options?.reasoning }); return fauxAssistantMessage("ok"); };
		faux.setResponses([record, record, record]);
		await runner().run(request());
		await runner().run(request({ role: { ...fakeRole("worker"), model: "herder-faux/other", thinking: "high" } }));
		await runner().run(request({ role: { ...fakeRole("worker"), thinking: "minimal" }, effort: "medium" }));
		expect(seen).toEqual([{ model: "main", reasoning: "low" }, { model: "other", reasoning: "high" }, { model: "main", reasoning: "medium" }]);
	});

	it("fails fatally for an unknown model, an unknown effort, or an invalid schema", async () => {
		expect((await rejection(runner().run(request({ role: { ...fakeRole("worker"), model: "herder-faux/missing" } })))).errorClass).toBe("fatal");
		expect((await rejection(runner().run(request({ effort: "extreme" })))).errorClass).toBe("fatal");
		expect((await rejection(runner().run(request({ schema: { type: "string" } })))).errorClass).toBe("fatal");
		expect(faux.state.callCount).toBe(0);
	});

	it("loads context files from the worktree and the agent dir only, plus the role prompt", async () => {
		writeFileSync(join(dir, "AGENTS.md"), "MAIN CHECKOUT RULES");
		writeFileSync(join(cwd, "AGENTS.md"), "WORKTREE RULES");
		writeFileSync(join(dir, "agent", "AGENTS.md"), "GLOBAL RULES");
		let systemPrompt = "";
		faux.setResponses([(context) => { systemPrompt = getCurrentSystemPrompt(context.messages); return fauxAssistantMessage("ok"); }]);
		await runner().run(request({ role: { ...fakeRole("worker"), prompt: "ROLE PROMPT TEXT" } }));
		expect(systemPrompt).toContain("WORKTREE RULES");
		expect(systemPrompt).toContain("GLOBAL RULES");
		expect(systemPrompt).toContain("ROLE PROMPT TEXT");
		expect(systemPrompt).not.toContain("MAIN CHECKOUT RULES");
	});

	it("disposes the session after success, provider errors, and stalls", async () => {
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		try {
			faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "503" }), hang]);
			await runner().run(request());
			await rejection(runner().run(request()));
			await rejection(runner().run(request({ stallMs: 100 })));
			expect(dispose).toHaveBeenCalledTimes(3);
		} finally {
			dispose.mockRestore();
		}
	});

	it("finds the runtime behind an extension's model registry", () => {
		expect(modelRuntimeOf(new ModelRegistry(runtime))).toBe(runtime);
		expect(modelRuntimeOf({ runtime })).toBe(runtime);
		expect(modelRuntimeOf({})).toBeUndefined();
		expect(modelRuntimeOf(undefined)).toBeUndefined();
	});
});
