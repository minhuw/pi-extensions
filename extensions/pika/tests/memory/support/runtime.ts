import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "../../../credentials.ts";
import { timing } from "../../../memory/client.ts";
import memoryExtension from "../../../memory/index.ts";
import type { Note } from "../../../memory/format.ts";
import { TOKEN } from "./pika-server.ts";

const DEFAULT_TIMING = { ...timing };
export const REMOTE = "git@github.com:me/widgets.git";
export const REPOSITORY = "https://github.com/me/widgets";
export const PROJECT = "my-project";

// Real pi sessions load slowly on a cold, busy worker; every memory test file imports this module.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/** A temp directory holding the agent dir, session dir, and project cwd (a git repository with an origin) of one test. */
export class Workspace {
	private constructor(readonly root: string) {}
	static async create(options: { git?: boolean } = {}): Promise<Workspace> {
		const workspace = new Workspace(await mkdtemp(join(tmpdir(), "pi-memory-")));
		for (const dir of [workspace.agentDir, workspace.sessionDir, workspace.cwd]) await mkdir(dir, { recursive: true });
		if (options.git !== false) {
			execFileSync("git", ["init", "-q", workspace.cwd]);
			execFileSync("git", ["-C", workspace.cwd, "remote", "add", "origin", REMOTE]);
		}
		for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED"]) delete process.env[name];
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		Object.assign(timing, DEFAULT_TIMING);
		return workspace;
	}
	get agentDir() { return join(this.root, "agent"); }
	get sessionDir() { return join(this.root, "sessions"); }
	get cwd() { return join(this.root, PROJECT); }
	async cleanup(): Promise<void> {
		setCredentials(undefined);
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Publishes credentials as pika would. */
export function setCredentials(url: string | undefined, options: { token?: string; excluded?: boolean } = {}): void {
	const registry = credentialsRegistry();
	registry.current = url === undefined ? undefined : { url, token: options.token ?? TOKEN, isExcluded: () => options.excluded ?? false };
	for (const listener of [...registry.listeners]) listener();
}

export interface Harness {
	runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	faux: FauxProviderHandle;
	/** The system prompt of every provider request, in order. */
	systems: string[];
	/** Runs one prompt the model answers with text, and returns the system prompt of its request. */
	run(prompt: string): Promise<string>;
	/** The session's `pika-memory` entries on the current branch. */
	pins(): unknown[];
	shutdown(): Promise<void>;
}

/** A real pi session runtime with memory and the faux provider. */
export async function startSession(options: {
	workspace: Workspace; cwd?: string; mode?: ExtensionContext["mode"]; sessionManager?: SessionManager; extensions?: ExtensionFactory[]; bindAsChild?: boolean; memory?: boolean;
}): Promise<Harness> {
	const cwd = options.cwd ?? options.workspace.cwd;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "memory-test-api", provider: "memory-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }, ...(options.memory === false ? [] : [memoryExtension]), ...(options.extensions ?? [])],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd, agentDir: options.workspace.agentDir, sessionManager: options.sessionManager ?? SessionManager.create(cwd, options.workspace.sessionDir),
	});
	const bind = () => runtime.session.bindExtensions(options.bindAsChild ? {} : { mode: options.mode ?? "rpc", onError: () => {} });
	runtime.setRebindSession(bind);
	await bind();
	const systems: string[] = [];
	let closed = false;
	return {
		runtime, faux, systems,
		get session() { return runtime.session; },
		async run(prompt) {
			const before = systems.length;
			faux.appendResponses([recording(systems, () => fauxAssistantMessage("ok"))]);
			await runtime.session.prompt(prompt);
			expect(systems.length).toBe(before + 1);
			return systems.at(-1)!;
		},
		pins: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "pika-memory" ? [entry.data] : []),
		async shutdown() {
			if (closed) return;
			closed = true;
			await runtime.dispose();
		},
	};
}

function recording(systems: string[], answer: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory {
	return ({ messages }) => {
		systems.push(getCurrentSystemPrompt(messages));
		return answer();
	};
}

/** Makes the model call one tool in its next turn, then answer "done", and runs that turn. */
export async function callTool(h: Harness, name: string, args: Parameters<typeof fauxToolCall>[1]): Promise<{ text: string; isError: boolean; details: unknown }> {
	h.faux.appendResponses([
		recording(h.systems, () => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })),
		recording(h.systems, () => fauxAssistantMessage("done")),
	]);
	await h.session.prompt(`call ${name}`);
	const result = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1) as
		{ content: { type: string; text?: string }[]; isError: boolean; details: unknown } | undefined;
	if (!result) throw new Error(`${name} was not called`);
	return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError, details: result.details };
}

/** The `memory` section of a system prompt, or undefined. */
export function memorySection(system: string): string | undefined {
	return /<memory>\n([\s\S]*?)\n<\/memory>/.exec(system)?.[1];
}

let counter = 0;
/** A note as the server returns it. */
export function note(fields: Partial<Note> = {}): Note {
	counter++;
	return {
		id: `abcdef${String(counter).padStart(6, "0")}`, scope: { key: `repo:${REPOSITORY}`, kind: "project", label: PROJECT }, category: "project",
		title: `Title ${counter}`, hook: `Hook ${counter}`, body: `Body ${counter}`, provenance: "agent", revision: 1,
		createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", deletedAt: null, deviceId: "laptop", sessionId: "s-old",
		...fields,
	};
}

export const USER_SCOPE = { key: "user", kind: "user" as const, label: "user" };
export const PROJECT_SCOPE = { key: `repo:${REPOSITORY}`, kind: "project" as const, label: PROJECT };
