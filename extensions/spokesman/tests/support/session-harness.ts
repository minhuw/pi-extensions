import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const SPOKESMAN_EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));

export type TestMessage = { role: string; content: unknown };

export const textOf = ({ content }: TestMessage): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

export interface SpokesmanTestEnv {
	readonly root: string;
	agentDir(): string;
	sessionDir(): string;
	cwd(): string;
	newManager(options?: { parentSession?: string }): SessionManager;
	track(disposable: { dispose(): Promise<void> }): void;
	setup(): Promise<void>;
	teardown(): Promise<void>;
}

/** Owns the temp-dir layout (`agent/`, `sessions/`, `work/`), `PI_CODING_AGENT_DIR`, and runtime disposal. */
export function createSpokesmanTestEnv(prefix = "pi-spokesman-"): SpokesmanTestEnv {
	let root = "";
	let previousAgentDir: string | undefined;
	const started: { dispose(): Promise<void> }[] = [];

	const agentDir = () => join(root, "agent");
	const sessionDir = () => join(root, "sessions");
	const cwd = () => join(root, "work");

	return {
		get root() {
			return root;
		},
		agentDir,
		sessionDir,
		cwd,
		newManager(options?: { parentSession?: string }) {
			return SessionManager.create(cwd(), sessionDir(), options);
		},
		track(disposable: { dispose(): Promise<void> }) {
			started.push(disposable);
		},
		async setup() {
			root = await mkdtemp(join(tmpdir(), prefix));
			await Promise.all([agentDir(), sessionDir(), cwd()].map((dir) => mkdir(dir)));
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir();
		},
		async teardown() {
			try {
				for (const item of started.splice(0)) await item.dispose();
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				if (root) {
					await rm(root, { recursive: true, force: true });
					root = "";
				}
			}
		},
	};
}

export interface SpokesmanSessionRuntimeOptions {
	env: SpokesmanTestEnv;
	api?: string;
	provider?: string;
	models: { id: string }[];
	initialModelId: string;
	sessionManager?: SessionManager;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	register?: (pi: ExtensionAPI) => void;
	configureFaux?: (faux: ReturnType<typeof fauxProvider>) => void;
}

/** Bootstraps a real Pi AgentSessionRuntime with the spokesman extension and faux provider. */
export async function createSpokesmanSessionRuntime(options: SpokesmanSessionRuntimeOptions) {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: options.api ?? "spokesman-test-api",
		provider: options.provider ?? "faux-openai",
		models: options.models,
	});
	options.configureFaux?.(faux);
	const settingsManager = SettingsManager.inMemory(
		options.settings ?? {
			retry: { enabled: false },
			compaction: { enabled: false },
		},
	);

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [SPOKESMAN_EXTENSION_PATH],
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						options.register?.(pi);
					},
				],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: faux.getModel(options.initialModelId),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.env.cwd(),
		agentDir: options.env.agentDir(),
		sessionManager: options.sessionManager ?? options.env.newManager(),
	});
	options.env.track(runtime);
	return { runtime, faux, modelRuntime, settingsManager };
}
