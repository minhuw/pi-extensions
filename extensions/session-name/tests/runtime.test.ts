import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

let directory: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-session-name-runtime-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(directory, { recursive: true, force: true });
});

it("names a real top-level session after its first run without changing the conversation", async () => {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "session-name-test-api", provider: "session-name-test", models: [{ id: "main" }] });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("main") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) });
	const errors: unknown[] = [];
	try {
		await runtime.session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
		faux.setResponses([fauxAssistantMessage("Renamed the helper."), fauxAssistantMessage("\"Rename the parser helper.\"")]);

		await runtime.session.prompt("Rename the parser helper in src/parse.ts");
		await vi.waitFor(() => expect(runtime.session.sessionManager.getSessionName()).toBe("Rename the parser helper"));
		expect(faux.state.callCount).toBe(2);
		expect(runtime.session.messages.map((message) => message.role).filter((role) => role !== "system")).toEqual(["user", "assistant"]);

		const recorded = runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "session-name.auto");
		expect(recorded.map((entry) => (entry as { data?: { name?: string } }).data?.name)).toEqual(["Rename the parser helper"]);

		// The name stays, later runs below the refresh step never ask again, and the record never reaches the model.
		let sent: unknown[] = [];
		faux.setResponses([(context) => { sent = context.messages; return fauxAssistantMessage("Done."); }]);
		await runtime.session.prompt("Thanks");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(faux.state.callCount).toBe(3);
		expect(sent.map((message) => (message as { role: string }).role).filter((role) => role !== "system")).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(sent)).not.toContain("session-name.auto");
		expect(runtime.session.sessionManager.getSessionName()).toBe("Rename the parser helper");
		expect(errors).toEqual([]);
	} finally {
		await runtime.dispose();
	}
}, 10_000);
