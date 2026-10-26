import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { MockProvider, ScriptedReply, ScriptedToolCall } from "../../../extensions/pika/tests/support/provider-server.ts";
import { check } from "./util.ts";

export const PROVIDER = "pika-e2e-openai";
/** A provider whose API exposes no request payload. */
export const LOCAL_PROVIDER = "pika-e2e-local";
const REPO = join(import.meta.dirname, "..", "..", "..");
/** The repository's extensions in its `pi.extensions` order, pika last. */
export const EXTENSIONS = ["extensions/subagents/src/index.ts", "extensions/herder/index.ts", "extensions/pika/index.ts"].map((path) => join(REPO, path));

/** A word that only a tool result contains, for the search check. */
export const SEARCH_WORD = "zephyrine";
export const AGENT_CALL_ID = "call_agent_1";
/** The tool call after whose batch a background subagent's completion notice is steered into the run. */
export const NOTICE_AFTER_CALL_ID = "call_bash_1";
export const NOTICE_TYPE = "subagent-notification";
const NOTICE = "Background agent finished: the changelog check is done.";

export const PROMPTS = {
	inspect: "Look at data.txt, then fix the typo in notes.md.",
	delegate: "Ask a worker to summarize the README.",
	herder: "/herder Survey the demo project",
	offline: "Run the offline check.",
	resumed: "Run the resumed check.",
	online: "Run the online check.",
	local: "Answer from the local model.",
	/** The first prompt of the machine that joins by pairing. */
	paired: "Run the paired check.",
	/** A prompt after that machine's device was revoked. */
	revoked: "Run the revoked check.",
};
const CHILD_PROMPT = "Read README.md and summarize it in one sentence.";
const STEP_PROMPT = "Survey README.md and report what it says.";

export const GOAL = `# Goal: Survey the demo project

## Intent
The maintainers want a short survey of the demo project.

## Acceptance criteria
- AC-1: WHEN the survey is done THE SYSTEM SHALL describe README.md. verify: check:readme

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| readme | test -f README.md | 1m | yes |

## Constraints
- Read only.

## Out of scope
- Changes to the project.
`;

export const PLAN = "# Plan\n\n- [ ] T1 (AC-1) Survey README.md\n";

export function model(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "mock-model", name: "Mock model", api: "openai-completions", provider: PROVIDER, baseUrl,
		reasoning: false, input: ["text"], cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
	} as Model<"openai-completions">;
}

/** The project the main session works in: a git repository, since Herder needs one. */
export function createProject(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nA small demo project for the pika end-to-end test.\n");
	writeFileSync(join(cwd, "notes.md"), "# Notes\n\nRemember to update teh changelog.\n");
	writeFileSync(join(cwd, "data.txt"), `inventory: ${SEARCH_WORD} crystals, 12 crates\n`);
	writeFileSync(join(cwd, "src", "app.ts"), "export const answer = 42;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("-c", "user.name=pika e2e", "-c", "user.email=e2e@pika.invalid", "commit", "-q", "-m", "Initial commit");
}

type Message = { role?: string; content?: unknown };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
	return "";
}

const call = (id: string, name: string, args: Record<string, unknown>): ScriptedToolCall => ({ id, name, arguments: args });

/** Which script a prompt follows; the first match wins. */
function scriptOf(prompt: string): string | undefined {
	if (prompt.includes(STEP_PROMPT)) return "step";
	if (prompt.includes(CHILD_PROMPT)) return "child";
	if (prompt.startsWith("/herder: run ")) return "herder";
	for (const [name, text] of Object.entries(PROMPTS)) if (prompt.includes(text)) return name;
	return undefined;
}

/**
 * Replies by the last user message and how many replies already follow it, so every session (main, subagent, Herder
 * step) gets its own script whatever the order of calls.
 */
export function responder(body: Record<string, unknown>): ScriptedReply | undefined {
	const messages = (body.messages ?? []) as Message[];
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && text(messages[i]!.content) !== NOTICE) { last = i; break; }
	const prompt = last >= 0 ? text(messages[last]!.content) : "";
	const step = messages.slice(last + 1).filter((message) => message.role === "assistant").length;
	const script = (replies: ScriptedReply[]) => replies[Math.min(step, replies.length - 1)];
	const name = scriptOf(prompt);
	switch (name) {
		case "inspect":
			return script([
				{ text: "Let me look at the data first.", toolCalls: [call("call_bash_1", "bash", { command: "cat data.txt && ls" })] },
				{ toolCalls: [call("call_read_1", "read", { path: "notes.md" })] },
				{ toolCalls: [call("call_edit_1", "edit", { path: "notes.md", edits: [{ oldText: "teh changelog", newText: "the changelog" }] })] },
				"The data lists the crystals, and I fixed the typo in notes.md.",
			]);
		case "delegate":
			return script([
				{ toolCalls: [call(AGENT_CALL_ID, "Agent", { subagent_type: "worker", description: "Summarize the README", prompt: CHILD_PROMPT })] },
				"The worker reports that the project is a small demo.",
			]);
		case "child":
			return script([
				{ toolCalls: [call("call_child_read", "read", { path: "README.md" })] },
				{ toolCalls: [call("call_child_bash", "bash", { command: "wc -l README.md" })] },
				"README.md describes a small demo project for the pika end-to-end test.",
			]);
		case "herder": {
			const goalPath = /^- goal\.md: (.+)$/m.exec(prompt)?.[1];
			const planPath = /^- plan\.md: (.+)$/m.exec(prompt)?.[1];
			if (!goalPath || !planPath) return "The Herder prompt names no goal.md.";
			return script([
				{ toolCalls: [call("call_goal", "write", { path: goalPath, content: GOAL })] },
				{ toolCalls: [call("call_approve", "herder_run", { action: "approve_goal" })] },
				{ toolCalls: [call("call_plan", "write", { path: planPath, content: PLAN })] },
				{ toolCalls: [call("call_step", "herder_step", { prompt: STEP_PROMPT, role: "explorer", task: "T1", label: "survey" })] },
				"The survey step finished.",
			]);
		}
		case "step":
			return script([
				{ toolCalls: [call("call_step_read", "read", { path: "README.md" })] },
				"**Answer** — README.md says this is a small demo project for the pika end-to-end test.",
			]);
		case "offline":
		case "resumed":
		case "online":
		case "paired":
		case "revoked":
			return script([
				{ toolCalls: [call(`call_${name}`, "bash", { command: `echo ${name} check` })] },
				`The ${name} check passed.`,
			]);
	}
	return "This prompt has no script.";
}

/** The dialogs a test may script; pi's UI-less context provides everything else. */
export type ScriptedDialogs = Pick<ExtensionUIContext, "notify" | "input" | "select">;

/**
 * A UI that answers every confirmation with yes, as the user approving Herder's goal, and `dialogs` when given;
 * everything else is a no-op.
 */
function approvingUi(session: AgentSession, approvals: string[], dialogs?: ScriptedDialogs): ExtensionUIContext {
	const base = session.extensionRunner.getUIContext();
	const ui = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base)) as ExtensionUIContext;
	ui.confirm = async (title: string) => { approvals.push(title); return true; };
	if (dialogs) Object.assign(ui, { notify: dialogs.notify, input: dialogs.input, select: dialogs.select });
	return ui;
}

export interface Pi {
	session: AgentSession;
	errors: unknown[];
	approvals: string[];
	/** The messages of each model call's context, as pi passed them to extensions, after a JSON round trip. */
	contexts: unknown[][];
	prompt(text: string): Promise<void>;
	shutdown(): Promise<void>;
}

/**
 * A real pi runtime with Subagents, Herder, and pika loaded by path, pika last, on the mock provider. `local` is a
 * model whose provider exposes no request payload. A listener after them records each call's context and, as
 * Subagents does for a background child that finishes while the parent works, steers a displayed notice into the run
 * at the `turn_end` after the tool batch of `NOTICE_AFTER_CALL_ID`.
 */
export async function startPi(options: {
	cwd: string; agentDir: string; sessionDir: string; provider: MockProvider; local: FauxProviderHandle; sessionFile?: string;
	/** Answers to pika's prompts, for `/pika login`. */
	dialogs?: ScriptedDialogs;
}): Promise<Pi> {
	const { cwd, agentDir, sessionDir, provider } = options;
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider(PROVIDER, { baseUrl: provider.baseUrl, apiKey: "e2e-key", api: "openai-completions", models: [{ ...model(provider.baseUrl) }] });
	runtime.registerNativeProvider(options.local.provider);
	const contexts: unknown[][] = [];
	const resources = new DefaultResourceLoader({
		cwd, agentDir, noExtensions: true, additionalExtensionPaths: EXTENSIONS,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			pi.on("context_with_system", (event) => { contexts.push(JSON.parse(JSON.stringify(event.messages)) as unknown[]); });
			pi.on("turn_end", (event) => {
				if (!event.toolResults.some((result) => result.toolCallId === NOTICE_AFTER_CALL_ID)) return;
				pi.sendMessage({ customType: NOTICE_TYPE, content: NOTICE, display: true }, { deliverAs: "steer", triggerTurn: true });
			});
		}],
	});
	await resources.reload();
	const loadErrors = resources.getExtensions().errors;
	check(loadErrors.length === 0, `extensions failed to load: ${JSON.stringify(loadErrors)}`);
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime: runtime, resourceLoader: resources, model: model(provider.baseUrl),
		sessionManager: options.sessionFile ? SessionManager.open(options.sessionFile, sessionDir) : SessionManager.create(cwd, sessionDir),
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "bash", "edit", "write"], retry: { enabled: false } }),
	});
	const errors: unknown[] = [];
	const approvals: string[] = [];
	await session.bindExtensions({ mode: "rpc", uiContext: approvingUi(session, approvals, options.dialogs), onError: (error) => { errors.push(error); } });
	let closed = false;
	return {
		session, errors, approvals, contexts,
		async prompt(input: string) {
			await session.prompt(input);
			// A command's follow-up message starts its turn after `prompt` returns.
			await session.waitForIdle();
			const last = session.messages.findLast((message) => message.role === "assistant");
			check(last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted",
				`the prompt ${JSON.stringify(input.slice(0, 40))} ended with ${last?.role === "assistant" ? `${last.stopReason}: ${last.errorMessage ?? ""}` : "no assistant message"}`);
		},
		async shutdown() {
			if (closed) return;
			closed = true;
			try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
		},
	};
}
