import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import impeccableExtension from "../../index.ts";
import { LIVE_SNAPSHOT, type LiveSaved } from "../../src/live.ts";

/** Actual AgentSession + resource loader, with in-memory credentials and only the faux provider. */
export async function liveSession(root: string, extra?: (pi: ExtensionAPI) => void, manager = SessionManager.inMemory(root)) {
	const faux = fauxProvider({ api: "impeccable-live-test-api", provider: "impeccable-live-test", models: [{ id: "test" }] });
	let api!: ExtensionAPI;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => { api = pi; pi.registerProvider(faux.provider); impeccableExtension(pi); extra?.(pi); }],
	});
	await resources.reload(); expect(resources.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: faux.getModel("test")!, resourceLoader: resources, sessionManager: manager, settingsManager: SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false } }) });
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
	return {
		session, faux, errors, get api() { return api; },
		saved: () => {
			const entry = session.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === LIVE_SNAPSHOT);
			return entry?.type === "custom" ? entry.data as LiveSaved : undefined;
		},
		async cleanup() { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
	};
}
