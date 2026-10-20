import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import loopExtension from "../index.ts";
import { ITERATION, SNAPSHOT } from "../state.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}
async function fixture(register?: (pi: ExtensionAPI) => void, registerAfterLoop = false) {
	const directory = await mkdtemp(join(tmpdir(), "pi-loop-runtime-"));
	let session: AgentSession | undefined;
	try {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ api: "loop-test-api", provider: "loop-test", models: [{ id: "test" }] });
		const resources = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				pi.registerProvider(faux.provider);
				if (!registerAfterLoop) register?.(pi);
				loopExtension(pi);
				if (registerAfterLoop) register?.(pi);
			}],
		});
		await resources.reload(); expect(resources.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources,
			sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false } }),
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
		const current = session;
		return { session: current, faux, errors, async cleanup() {
			try { await current.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); current.dispose(); }
			finally { await rm(directory, { recursive: true, force: true }); }
		} };
	} catch (error) {
		session?.dispose(); await rm(directory, { recursive: true, force: true }); throw error;
	}
}

it("runs a real Pi custom-message iteration and its stop tool with a local faux provider", async () => {
	const h = await fixture();
	try {
		const settled = deferred();
		h.session.subscribe((event) => { if (event.type === "agent_settled") settled.resolve(); });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("loop_stop", { reason: "CI is green" })]),
			fauxAssistantMessage("CI is green"),
		]);
		await h.session.prompt("/loop 1m check CI --name build --max 2");
		await settled.promise;
		expect(h.faux.state.callCount).toBe(2);
		const snapshot = h.session.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === SNAPSHOT);
		expect(snapshot?.type === "custom" && snapshot.data).toMatchObject({ loops: [{ name: "build", status: "done", iteration: 1, reason: "CI is green" }] });
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 10_000);

it.each([
	{ action: "stop", after: false }, { action: "pause", after: false },
	{ action: "stop", after: true }, { action: "pause", after: true },
])("$action during real Pi run preparation (later hook: $after) cancels before the provider is called", async ({ action, after }) => {
	const preparing = deferred(); const release = deferred(); const settled = deferred();
	const h = await fixture((pi) => {
		pi.on("before_agent_start", async (event) => {
			if (event.messageType === "custom" && event.message.customType === ITERATION) { preparing.resolve(); await release.promise; }
		});
	}, after);
	try {
		h.session.subscribe((event) => { if (event.type === "agent_settled") settled.resolve(); });
		h.faux.setResponses([fauxAssistantMessage("Must not be requested")]);
		await h.session.prompt("/loop 1m check CI --name build");
		await preparing.promise;
		await h.session.prompt(`/loop ${action} build`);
		release.resolve();
		await settled.promise;
		expect(h.faux.state.callCount).toBe(0);
		expect(h.errors).toEqual([]);
	} finally { release.resolve(); await h.cleanup(); }
}, 10_000);
