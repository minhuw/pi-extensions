import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import impeccableExtension from "../../index.ts";

export interface ImpeccableTestSessionOptions {
	cwd: string;
	agentDir?: string;
	api: string;
	provider: string;
	sessionManager?: SessionManager;
	defaultTools?: string[];
	noPromptTemplates?: boolean;
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	beforeImpeccable?: (pi: ExtensionAPI) => void;
	afterImpeccable?: (pi: ExtensionAPI) => void;
	extensionFactories?: ExtensionFactory[];
	uiContext?: ExtensionUIContext;
	assertNoExtensionErrors?: boolean;
}

export interface ImpeccableTestSession {
	session: AgentSession;
	faux: ReturnType<typeof fauxProvider>;
	errors: unknown[];
	readonly api: ExtensionAPI;
}

/** Shared offline Pi AgentSession harness for impeccable tests (in-memory credentials + faux provider). */
export async function createImpeccableTestSession(
	options: ImpeccableTestSessionOptions,
): Promise<ImpeccableTestSession> {
	const agentDir = options.agentDir ?? options.cwd;
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: options.api,
		provider: options.provider,
		models: [{ id: "test" }],
	});
	let api!: ExtensionAPI;
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: options.noPromptTemplates ?? true,
		noThemes: true,
		noContextFiles: true,
		...(options.additionalSkillPaths !== undefined
			? { additionalSkillPaths: options.additionalSkillPaths }
			: {}),
		...(options.additionalPromptTemplatePaths !== undefined
			? { additionalPromptTemplatePaths: options.additionalPromptTemplatePaths }
			: {}),
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.registerProvider(faux.provider);
				options.beforeImpeccable?.(pi);
				impeccableExtension(pi);
				options.afterImpeccable?.(pi);
			},
			...(options.extensionFactories ?? []),
		],
	});
	await resourceLoader.reload();
	if (options.assertNoExtensionErrors !== false) {
		expect(resourceLoader.getExtensions().errors).toEqual([]);
	}
	const settingsManager = SettingsManager.inMemory({
		...(options.defaultTools !== undefined ? { defaultTools: options.defaultTools } : {}),
		retry: { enabled: false },
	});
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel("test")!,
		resourceLoader,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
		settingsManager,
	});
	const errors: unknown[] = [];
	try {
		await session.bindExtensions({
			mode: "rpc",
			...(options.uiContext !== undefined ? { uiContext: options.uiContext } : {}),
			onError: (error) => errors.push(error),
		});
	} catch (error) {
		session.dispose();
		throw error;
	}
	return {
		session,
		faux,
		errors,
		get api() {
			return api;
		},
	};
}
