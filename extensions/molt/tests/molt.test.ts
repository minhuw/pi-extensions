import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// Load by path, as Pi does, so each replacement session re-imports the module.
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

async function fixture(register?: (pi: ExtensionAPI) => void) {
	const directory = await mkdtemp(join(tmpdir(), "pi-molt-"));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "molt-test-api", provider: "molt-test", models: [{ id: "startup", reasoning: true }, { id: "chosen", reasoning: true }] });
	const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "low", retry: { enabled: false } });
	// Like `pi --model`, every replacement session starts from the same configured model.
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); register?.(pi); }],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("startup") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) });
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions({
		mode: "rpc",
		onError: (error) => { errors.push(error); },
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (options) => runtime.newSession(options),
			fork: (entryId, options) => runtime.fork(entryId, options),
			navigateTree: (targetId, options) => runtime.session.navigateTree(targetId, options),
			switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
			reload: () => runtime.session.reload(),
		},
	});
	runtime.setRebindSession(bind);
	await bind();
	const state = () => ({ model: runtime.session.model?.id, thinking: runtime.session.thinkingLevel, id: runtime.session.sessionId });
	return { runtime, faux, settingsManager, errors, state, async cleanup() {
		try { await runtime.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
	} };
}

it("starts an empty session with the current model and thinking level, once", async () => {
	const h = await fixture();
	try {
		await h.runtime.session.setModel(h.faux.getModel("chosen")!);
		h.runtime.session.setThinkingLevel("high");
		const before = h.state();
		expect(before).toMatchObject({ model: "chosen", thinking: "high" });

		await h.runtime.session.prompt("/molt");
		expect(h.state()).toMatchObject({ model: "chosen", thinking: "high" });
		expect(h.state().id).not.toBe(before.id);
		expect(h.runtime.session.messages).toEqual([]);
		expect(h.settingsManager.getDefaultModel()).toBeUndefined();
		expect(h.settingsManager.getDefaultThinkingLevel()).toBe("low");

		// A plain new session still starts from the configured model and thinking level.
		await h.runtime.newSession();
		expect(h.state()).toMatchObject({ model: "startup", thinking: "low" });
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 10_000);

it("keeps them when the replacement session loads a fresh copy of the module", async () => {
	const h = await fixture();
	const elsewhere = await mkdtemp(join(tmpdir(), "pi-molt-elsewhere-"));
	try {
		await h.runtime.session.setModel(h.faux.getModel("chosen")!);
		h.runtime.session.setThinkingLevel("high");
		// Pi caches extension modules for one cwd. A load elsewhere, such as a worktree
		// subagent, makes the next replacement session re-import this module.
		const other = new DefaultResourceLoader({
			cwd: elsewhere, agentDir: elsewhere, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [extensionPath],
		});
		await other.reload();

		await h.runtime.session.prompt("/molt");
		expect(h.state()).toMatchObject({ model: "chosen", thinking: "high" });
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); await rm(elsewhere, { recursive: true, force: true }); }
}, 10_000);

/** Answers with `reply` and records the conversation the model was sent. */
function answer(reply: Parameters<typeof fauxAssistantMessage>[0], seen: string[], options?: Parameters<typeof fauxAssistantMessage>[1]): FauxResponseFactory {
	return (context) => { seen.push(JSON.stringify(context.messages)); return fauxAssistantMessage(reply, options); };
}

function firstUserText(messages: readonly { role: string; content?: unknown }[]): string {
	const content = messages.find((message) => message.role === "user")?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
}

it("has the model write a handover, then sends it as the first message of a new session", async () => {
	const h = await fixture();
	try {
		const seen: string[] = [];
		h.faux.setResponses([
			answer("We fixed the parser; tests still fail.", seen),
			// The handover turn may check state with tools first; only its last final reply counts.
			answer([fauxToolCall("bash", { command: "true" })], seen, { stopReason: "toolUse" }),
			answer("# Handover\nRun the parser tests.", seen),
			answer("Running them now.", seen),
		]);
		await h.runtime.session.setModel(h.faux.getModel("chosen")!);
		h.runtime.session.setThinkingLevel("high");
		await h.runtime.session.prompt("Fix the parser.");
		const before = h.state();

		await h.runtime.session.prompt("/handoff run the parser tests");
		await vi.waitFor(() => {
			expect(h.state().id).not.toBe(before.id);
			expect(h.runtime.session.messages.map((message) => message.role).filter((role) => role !== "system")).toEqual(["user", "assistant"]);
			expect(h.runtime.session.isIdle).toBe(true);
		});

		expect(seen).toHaveLength(4);
		expect(seen[1]).toContain("Fix the parser.");
		expect(seen[1]).toContain("The new session's task: run the parser tests");
		// The new session sees the handover only, not the old conversation or the request.
		expect(seen[3]).toContain("Run the parser tests.");
		expect(seen[3]).not.toContain("Fix the parser.");
		expect(seen[3]).not.toContain("Write a handover");
		expect(firstUserText(h.runtime.session.messages)).toBe(`# Handover\nRun the parser tests.\n\n---\nHanded off from pi session ${before.id}.`);
		expect(h.state()).toMatchObject({ model: "chosen", thinking: "high" });
		// A standalone session, not a child of the old one.
		expect(h.runtime.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 10_000);

it("stays in the session when the model does not finish a handover", async () => {
	const h = await fixture();
	try {
		const seen: string[] = [];
		h.faux.setResponses([
			answer("Done with step one.", seen),
			answer("", seen, { stopReason: "error", errorMessage: "provider failed" }),
			answer("Plain reply.", seen),
		]);
		await h.runtime.session.prompt("Do step one.");
		const before = h.state();

		await h.runtime.session.prompt("/handoff");
		await vi.waitFor(() => { expect(seen).toHaveLength(2); expect(h.runtime.session.isIdle).toBe(true); });
		// A later ordinary run is not taken for the handover.
		await h.runtime.session.prompt("Carry on.");
		expect(h.state().id).toBe(before.id);
		expect(seen).toHaveLength(3);
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 10_000);

it("does nothing in a session without a conversation", async () => {
	const h = await fixture();
	try {
		const before = h.state();
		await h.runtime.session.prompt("/handoff");
		expect(h.state().id).toBe(before.id);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 10_000);

it("does not carry settings into a later plain new session after a cancelled switch", async () => {
	let cancel = true;
	const h = await fixture((pi) => { pi.on("session_before_switch", () => cancel ? { cancel: true } : undefined); });
	try {
		await h.runtime.session.setModel(h.faux.getModel("chosen")!);
		h.runtime.session.setThinkingLevel("high");
		const before = h.state();

		await h.runtime.session.prompt("/molt");
		expect(h.state()).toEqual(before);

		cancel = false;
		await h.runtime.newSession();
		expect(h.state()).toMatchObject({ model: "startup", thinking: "low" });
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 10_000);
