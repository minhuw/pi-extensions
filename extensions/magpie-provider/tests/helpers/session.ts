import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";

type BindExtensionsOptions = Parameters<AgentSession["bindExtensions"]>[0];

export interface MagpieTestSessionOptions {
	cwd: string;
	agentDir?: string;
	model: CreateAgentSessionOptions["model"];
	modelRuntime?: ModelRuntime;
	credentials?: InMemoryCredentialStore;
	modelsStorePath?: string;
	sessionManager?: SessionManager;
	settingsManager?: SettingsManager;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	extensionFactories?: ExtensionFactory[];
	additionalExtensionPaths?: string[];
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	noTools?: CreateAgentSessionOptions["noTools"];
	bindExtensions?: BindExtensionsOptions | ((session: AgentSession) => BindExtensionsOptions) | false;
}

export interface MagpieTestSession {
	session: AgentSession;
	modelRuntime: ModelRuntime;
	resourceLoader: DefaultResourceLoader;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}

/** Shared offline Pi AgentSession harness for magpie-provider SDK integration tests. */
export async function createMagpieTestSession(
	options: MagpieTestSessionOptions,
): Promise<MagpieTestSession> {
	const agentDir = options.agentDir ?? options.cwd;
	const settingsManager = options.settingsManager ?? SettingsManager.inMemory(options.settings ?? { defaultTools: [] });
	const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
		credentials: options.credentials ?? new InMemoryCredentialStore(),
		modelsPath: null,
		...(options.modelsStorePath !== undefined ? { modelsStorePath: options.modelsStorePath } : {}),
		refreshOnCreate: false,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...(options.additionalExtensionPaths !== undefined
			? { additionalExtensionPaths: options.additionalExtensionPaths }
			: {}),
		...(options.extensionFactories !== undefined
			? { extensionFactories: options.extensionFactories }
			: {}),
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const sessionManager = options.sessionManager ?? SessionManager.inMemory(options.cwd);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime,
		model: options.model,
		resourceLoader,
		sessionManager,
		settingsManager,
		...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
		...(options.noTools !== undefined ? { noTools: options.noTools } : {}),
	});
	if (options.bindExtensions !== false) {
		try {
			const bindOptions = typeof options.bindExtensions === "function"
				? options.bindExtensions(session)
				: (options.bindExtensions ?? { onError: (error) => { throw new Error(error.error); } });
			await session.bindExtensions(bindOptions);
		} catch (error) {
			session.dispose();
			throw error;
		}
	}
	return { session, modelRuntime, resourceLoader, sessionManager, settingsManager };
}
