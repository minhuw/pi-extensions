import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { type CredentialsRegistry, credentialsRegistry } from "../../../credentials.ts";
import { timing } from "../../../recall/client.ts";
import recallExtension from "../../../recall/index.ts";
import { TOKEN } from "./pika-server.ts";

const DEFAULT_TIMING = { ...timing };

// Real pi sessions load slowly on a cold, busy worker; every recall test file imports this module.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/** A temp directory holding the agent dir, session dir, and project cwd of one test. */
export class Workspace {
	private constructor(readonly root: string) {}
	static async create(): Promise<Workspace> {
		const workspace = new Workspace(await mkdtemp(join(tmpdir(), "pi-recall-")));
		for (const dir of [workspace.agentDir, workspace.sessionDir, workspace.cwd]) await mkdir(dir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		Object.assign(timing, DEFAULT_TIMING);
		return workspace;
	}
	get agentDir() { return join(this.root, "agent"); }
	get sessionDir() { return join(this.root, "sessions"); }
	get cwd() { return join(this.root, "my-project"); }
	async cleanup(): Promise<void> {
		setCredentials(undefined);
		delete credentialsRegistry().repository;
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Publishes credentials as pika would. */
export function setCredentials(url: string | undefined, options: { token?: string; repository?: CredentialsRegistry["repository"] } = {}): void {
	const registry = credentialsRegistry();
	registry.current = url === undefined ? undefined : { url, token: options.token ?? TOKEN, isExcluded: () => false };
	if (options.repository) registry.repository = options.repository;
	for (const listener of [...registry.listeners]) listener();
}

export interface Harness {
	runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	faux: FauxProviderHandle;
	shutdown(): Promise<void>;
}

/** A real pi session runtime with recall and the faux provider. */
export async function startSession(options: { workspace: Workspace; cwd?: string; mode?: ExtensionContext["mode"]; extensions?: ExtensionFactory[] }): Promise<Harness> {
	const cwd = options.cwd ?? options.workspace.cwd;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "recall-test-api", provider: "recall-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }, recallExtension, ...(options.extensions ?? [])],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd, agentDir: options.workspace.agentDir, sessionManager: SessionManager.create(cwd, options.workspace.sessionDir),
	});
	await runtime.session.bindExtensions({ mode: options.mode ?? "rpc", onError: () => {} });
	let closed = false;
	return {
		runtime, faux,
		get session() { return runtime.session; },
		async shutdown() {
			if (closed) return;
			closed = true;
			await runtime.dispose();
		},
	};
}

/** Makes the model call one tool in its next turn, then answer "done", and runs that turn. */
export async function callTool(h: Harness, name: string, args: Parameters<typeof fauxToolCall>[1]): Promise<{ text: string; isError: boolean; details: unknown }> {
	h.faux.appendResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await h.session.prompt(`call ${name}`);
	const result = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1) as
		{ content: { type: string; text?: string }[]; isError: boolean; details: unknown } | undefined;
	if (!result) throw new Error(`${name} was not called`);
	return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError, details: result.details };
}
