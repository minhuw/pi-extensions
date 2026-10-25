import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { TOKEN } from "./ingest-server.ts";

export const OPENAI_PROVIDER = "pika-mock-openai";

export function openAiModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "mock-model", name: "Mock model", api: "openai-completions", provider: OPENAI_PROVIDER, baseUrl,
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
	} as Model<"openai-completions">;
}

/** A temp directory holding the agent dir, session dir, and project cwd of one test. */
export class Workspace {
	private constructor(readonly root: string) {}
	static async create(): Promise<Workspace> {
		const workspace = new Workspace(await mkdtemp(join(tmpdir(), "pi-pika-")));
		for (const dir of [workspace.agentDir, workspace.sessionDir, workspace.cwd]) await mkdir(dir, { recursive: true });
		for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED"]) delete process.env[name];
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		return workspace;
	}
	get agentDir() { return join(this.root, "agent"); }
	get sessionDir() { return join(this.root, "sessions"); }
	get cwd() { return join(this.root, "project"); }
	get pikaDir() { return join(this.agentDir, "pika"); }
	async configure(config: Record<string, unknown> | undefined): Promise<void> {
		if (config === undefined) await rm(join(this.agentDir, "pika.json"), { force: true });
		else await writeFile(join(this.agentDir, "pika.json"), JSON.stringify(config));
	}
	async enable(url: string, extra: Record<string, unknown> = {}): Promise<void> {
		await this.configure({ url, token: TOKEN, ...extra });
	}
	async cleanup(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

export interface SessionOptions {
	workspace: Workspace;
	/** Extension factories in load order. */
	extensions: ExtensionFactory[];
	/** Extensions loaded by path before the factories, as Pi loads packages. */
	extensionPaths?: string[];
	sessionManager?: SessionManager;
	cwd?: string;
	/** Serve the model through a real OpenAI-compatible API implementation at this base URL. */
	openAiBaseUrl?: string;
	faux?: FauxProviderHandle;
	tools?: string[];
}

export interface Harness {
	session: AgentSession;
	faux: FauxProviderHandle;
	errors: unknown[];
	shutdown(): Promise<void>;
}

export async function startSession(options: SessionOptions): Promise<Harness> {
	const cwd = options.cwd ?? options.workspace.cwd;
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = options.faux ?? fauxProvider({ api: "pika-test-api", provider: "pika-test", models: [{ id: "test" }] });
	const baseUrl = options.openAiBaseUrl;
	const resources = new DefaultResourceLoader({
		cwd, agentDir: options.workspace.agentDir, noExtensions: true, additionalExtensionPaths: options.extensionPaths, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerProvider(faux.provider);
				if (baseUrl) pi.registerProvider(OPENAI_PROVIDER, { baseUrl, apiKey: "test-key", api: "openai-completions", models: [{ ...openAiModel(baseUrl) }] });
			},
			...options.extensions,
		],
	});
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd, agentDir: options.workspace.agentDir, modelRuntime: runtime, resourceLoader: resources,
		model: baseUrl ? openAiModel(baseUrl) : faux.getModel("test")!,
		sessionManager: options.sessionManager ?? SessionManager.create(cwd, options.workspace.sessionDir),
		settingsManager: SettingsManager.inMemory({ defaultTools: options.tools ?? [], retry: { enabled: false } }),
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
	let closed = false;
	return {
		session, faux, errors,
		async shutdown() {
			if (closed) return;
			closed = true;
			try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
		},
	};
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = "condition"): Promise<number> {
	const started = Date.now();
	for (;;) {
		if (await check()) return Date.now() - started;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}
