import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type CreateAgentSessionOptions, type ExtensionFactory, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { CHILD_SESSION_HOOKS, SESSION_LINK_TYPE, STRUCTURED_OUTPUT_REJECTIONS, STRUCTURED_OUTPUT_TOOL } from "../config.ts";
import { AgentError, type AgentRunner, type AgentRunRequest, type AgentRunResult, type OutputStore, type Usage } from "../types.ts";
import { classifyMessage, toAgentError } from "./classify.ts";
import { allowedTools, THINKING_LEVELS } from "./roles.ts";
import { checkSchema, createStructuredOutputTool, structuredReminder, type StructuredCapture } from "./structured.ts";

type Model = NonNullable<CreateAgentSessionOptions["model"]>;
type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

export interface PiRunnerOptions {
	/** The main session's runtime (see `modelRuntimeOf`); default: a runtime built from `agentDir`. */
	modelRuntime?: ModelRuntime;
	/** Model for roles with `model: inherit`; when it returns undefined, Pi picks its configured default. */
	inheritModel?: () => Model | undefined;
	/** Thinking level for roles with `thinking: inherit`; when it returns undefined, Pi picks its default. */
	inheritThinking?: () => ThinkingLevel | undefined;
	/** When given, each run stores its transcript (JSON messages) as `transcriptRef` on its result or `AgentError`. */
	outputs?: OutputStore;
	agentDir?: string;
	/** One manager per run, shared by the resource loader and the session; must list no packages. Default: `stepSettings`. */
	settings?: (cwd: string, agentDir: string) => SettingsManager;
	/** How long a stopped run waits for the session to go idle before rejecting. */
	abortGraceMs?: number;
	/**
	 * The run the sessions belong to. When given, each session is a Pi session file in `dir` that starts with a
	 * `pi-extensions.session-link` entry; otherwise sessions stay in memory. `parentSessionFile` becomes the header's
	 * `parentSession`.
	 */
	sessions?: { dir: string; runId: string; repo: string; parentSessionId?: string; parentSessionFile?: string };
}

/** An entry of the shared child-session hook Set; extensions register these without importing each other. */
interface ChildSessionHook { name: string; extensionFactory: ExtensionFactory }

/** Hooks registered in `globalThis[Symbol.for("pi-extensions.child-session-hooks")]`; the Set may not exist. */
export function childSessionHooks(): InlineExtension[] {
	const hooks = (globalThis as Record<symbol, unknown>)[Symbol.for(CHILD_SESSION_HOOKS)];
	if (!(hooks instanceof Set)) return [];
	return [...hooks as Set<Partial<ChildSessionHook>>]
		.filter((hook): hook is ChildSessionHook => typeof hook?.name === "string" && typeof hook.extensionFactory === "function")
		.map((hook) => ({ name: hook.name, factory: hook.extensionFactory }));
}

/** How long a step session's `session_shutdown` handlers may run before it is disposed anyway. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

// No packages, extensions, or resource paths: the loader would resolve and install them on every step.
const STEP_SETTINGS: (keyof Settings)[] = [
	"defaultProvider", "defaultModel", "defaultThinkingLevel", "modelThinkingLevels", "thinkingBudgets", "transport", "retry", "compaction",
	"shellPath", "shellCommandPrefix", "images",
];

/**
 * In-memory settings for a step session: a few of the user's global settings, never the worktree's project settings,
 * which come from the repository being worked on.
 */
export function stepSettings(cwd: string, agentDir: string): SettingsManager {
	const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getGlobalSettings();
	const kept = Object.fromEntries(STEP_SETTINGS.filter((key) => global[key] !== undefined).map((key) => [key, global[key]]));
	return SettingsManager.inMemory(kept, { projectTrusted: false });
}

/**
 * `ExtensionContext.modelRegistry` wraps the session's `ModelRuntime` without exposing it. Undefined when Pi's private
 * field changes; callers must then warn that steps use a runtime of their own (their models and logins may differ).
 */
export function modelRuntimeOf(registry: unknown): ModelRuntime | undefined {
	const runtime = (registry as { runtime?: { getModel?: unknown } } | undefined)?.runtime;
	return typeof runtime?.getModel === "function" ? runtime as ModelRuntime : undefined;
}

/**
 * The production `AgentRunner`: one `createAgentSession` per attempt, one prompt, disposed in every outcome.
 * An abort through `request.signal` rejects with `AgentError("fatal", "aborted")`; the executor reports it as stopped.
 */
export function createPiAgentRunner(options: PiRunnerOptions = {}): AgentRunner {
	const agentDir = options.agentDir ?? getAgentDir();
	let runtime: Promise<ModelRuntime> | undefined = options.modelRuntime && Promise.resolve(options.modelRuntime);
	const modelRuntime = () => runtime ??= ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	return { run: (request) => runAgent(request, { ...options, agentDir, modelRuntime }) };
}

interface RunContext extends Omit<PiRunnerOptions, "modelRuntime"> { agentDir: string; modelRuntime: () => Promise<ModelRuntime> }

async function runAgent(request: AgentRunRequest, context: RunContext): Promise<AgentRunResult> {
	if (request.signal.aborted) throw new AgentError("fatal", "aborted");
	const { role, schema } = request;
	const thinkingLevel = resolveThinking(request, context);
	if (schema) {
		const problems = checkSchema(schema);
		if (problems.length) throw new AgentError("fatal", `Invalid StructuredOutput schema: ${problems.join("; ")}`);
	}
	const capture: StructuredCapture | undefined = schema ? { accepted: false, rejections: 0 } : undefined;
	let turnRejected = false;
	const watch = watchdog(request);
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	const hooks = childSessionHooks();
	try {
		session = await watch.race((async () => {
			const runtime = await context.modelRuntime();
			const model = resolveModel(role.model, runtime, context);
			const settingsManager = (context.settings ?? stepSettings)(request.cwd, context.agentDir);
			const loader = new DefaultResourceLoader({
				cwd: request.cwd, agentDir: context.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: hooks,
				agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: agentsFiles.filter((file) => within(file.path, [request.cwd, context.agentDir])) }),
				appendSystemPromptOverride: (base) => [...base, role.prompt],
			});
			await loader.reload();
			const tools = allowedTools(role.write, role.tools);
			const created = await createAgentSession({
				cwd: request.cwd, agentDir: context.agentDir, modelRuntime: runtime, resourceLoader: loader,
				sessionManager: context.sessions ? stepSessionManager(request.cwd, context.sessions) : SessionManager.inMemory(request.cwd), settingsManager,
				tools: capture ? [...tools, STRUCTURED_OUTPUT_TOOL] : tools,
				customTools: schema && capture ? [createStructuredOutputTool(schema, capture)] : [],
				...(model && { model }), ...(thinkingLevel && { thinkingLevel }),
			});
			if (context.sessions) created.session.sessionManager.appendCustomEntry(SESSION_LINK_TYPE, sessionLink(request, context.sessions));
			return created.session;
		})(), (created) => void shutdown(created));
		const live = session;
		request.onSession?.({ id: live.sessionId, ...(live.sessionFile !== undefined && { file: live.sessionFile }) });
		// Hooked extensions see `session_start` like in a main session; without hooks there is nothing to bind.
		if (hooks.length) await watch.race(live.bindExtensions({}));
		unsubscribe = live.subscribe((event) => {
			watch.touch();
			request.onEvent?.(event.type);
			if (event.type === "turn_start") turnRejected = false;
			// Parallel rejected calls in one turn are one attempt.
			if (capture && event.type === "tool_execution_end" && event.toolName === STRUCTURED_OUTPUT_TOOL && event.isError) {
				capture.lastError = resultText(event.result);
				if (turnRejected) return;
				turnRejected = true;
				capture.rejections++;
				if (capture.rejections >= STRUCTURED_OUTPUT_REJECTIONS) watch.fail(invalidOutput(capture));
			}
		});
		request.onLiveSession?.(live);
		await watch.race(converse(live, request, capture, watch));
		return result(live, capture, context.outputs);
	} catch (error) {
		if (session && watch.failed) await settle(session.abort(), context.abortGraceMs ?? 5_000);
		const failure = toAgentError(error);
		const transcriptRef = session && context.outputs ? storeFailedTranscript(session, context.outputs) : undefined;
		if (!transcriptRef) throw failure;
		throw new AgentError(failure.errorClass, failure.message, { ...(failure.cause !== undefined && { cause: failure.cause }), transcriptRef });
	} finally {
		watch.clear();
		unsubscribe?.();
		if (session) await shutdown(session);
		if (session) request.onLiveSession?.(undefined);
	}
}

type RunSessions = NonNullable<PiRunnerOptions["sessions"]>;

function stepSessionManager(cwd: string, run: RunSessions): SessionManager {
	return SessionManager.create(cwd, run.dir, run.parentSessionFile !== undefined ? { parentSession: run.parentSessionFile } : undefined);
}

/** The step's `pi-extensions.session-link` data (`kind: "herder-step"`). */
function sessionLink(request: AgentRunRequest, run: RunSessions): object {
	const step = request.step;
	return {
		kind: "herder-step",
		...(run.parentSessionId !== undefined && { parentSessionId: run.parentSessionId }),
		...(run.parentSessionFile !== undefined && { parentSessionFile: run.parentSessionFile }),
		agentType: request.role.name,
		...(step?.task !== undefined && { description: step.task }),
		herder: {
			runId: run.runId, stepKey: step?.key ?? request.role.name, stepId: step?.id ?? request.role.name,
			...(step?.task !== undefined && { task: step.task }),
			role: request.role.name, attempt: step?.attempt ?? 1,
			...(step?.launch !== undefined && { launch: step.launch }),
			repo: run.repo,
		},
	};
}

/** Emits `session_shutdown` to hooked extensions (bounded), then disposes the session. */
async function shutdown(session: AgentSession): Promise<void> {
	try {
		const runner = session.extensionRunner;
		if (runner.hasHandlers("session_shutdown")) {
			await settle(runner.emit({ type: "session_shutdown", reason: "quit" }), SHUTDOWN_TIMEOUT_MS);
		}
	} catch {}
	session.dispose();
}

/** A prompt that ends without an accepted payload is one rejection, unless a rejected call during it already counted. */
async function converse(session: AgentSession, request: AgentRunRequest, capture: StructuredCapture | undefined, watch: Watchdog): Promise<void> {
	let counted = capture?.rejections ?? 0;
	await session.prompt(request.prompt, { expandPromptTemplates: false });
	assertCompleted(session);
	while (capture && !capture.accepted) {
		if (capture.rejections === counted) capture.rejections++;
		if (capture.rejections >= STRUCTURED_OUTPUT_REJECTIONS) throw invalidOutput(capture);
		// The run may have already failed while this prompt was finishing; the race no longer awaits this loop.
		if (watch.failed) throw watch.failed;
		if (request.signal.aborted) throw new AgentError("fatal", "aborted");
		counted = capture.rejections;
		await session.prompt(structuredReminder(capture), { expandPromptTemplates: false });
		assertCompleted(session);
	}
}

const invalidOutput = (capture: StructuredCapture) =>
	new AgentError("invalid_output", `${STRUCTURED_OUTPUT_TOOL} rejected ${capture.rejections} times${capture.lastError ? `; last: ${capture.lastError}` : ""}`);

/** Pi has already retried a provider error internally when the run ends with `stopReason: "error"`. */
function assertCompleted(session: AgentSession): void {
	const last = session.messages.findLast((message) => message.role === "assistant");
	if (last?.role !== "assistant") return;
	if (last.stopReason === "error") {
		const message = last.errorMessage ?? "provider error";
		throw new AgentError(classifyMessage(message), message);
	}
	if (last.stopReason === "aborted") throw new AgentError("fatal", last.errorMessage ?? "aborted");
}

function result(session: AgentSession, capture: StructuredCapture | undefined, outputs: OutputStore | undefined): AgentRunResult {
	const usage: Usage = { input: 0, output: 0 };
	let cost: number | undefined;
	for (const message of session.messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		usage.input += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		usage.output += message.usage.output;
		if (message.usage.cost) cost = (cost ?? 0) + message.usage.cost.total;
	}
	if (cost !== undefined) usage.cost = cost;
	const run: AgentRunResult = { text: session.getLastAssistantText() ?? "", usage };
	if (capture) run.data = capture.data;
	if (outputs) run.transcriptRef = outputs.put(JSON.stringify(session.messages));
	return run;
}

/** A store failure must not replace the run's own error class. */
function storeFailedTranscript(session: AgentSession, outputs: OutputStore): string | undefined {
	try { return outputs.put(JSON.stringify(session.messages)); } catch { return undefined; }
}

function resolveModel(spec: string, runtime: ModelRuntime, context: RunContext): Model | undefined {
	if (spec === "inherit") return context.inheritModel?.();
	const slash = spec.indexOf("/");
	const model = slash > 0 ? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	if (!model) throw new AgentError("fatal", `Unknown model ${JSON.stringify(spec)}`);
	return model;
}

function resolveThinking(request: AgentRunRequest, context: RunContext): ThinkingLevel | undefined {
	const level = request.effort ?? request.role.thinking;
	if (level === "inherit") return context.inheritThinking?.();
	if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new AgentError("fatal", `Unknown thinking level ${JSON.stringify(level)}`);
	return level as ThinkingLevel;
}

/** Step worktrees live inside the main repository, so ancestor discovery would also pick up the main checkout's context files. */
function within(path: string, roots: string[]): boolean {
	const real = (value: string) => { try { return realpathSync(value); } catch { return resolve(value); } };
	return roots.some((root) => [resolve(root), real(root)].some((base) => [resolve(path), real(path)].some((candidate) => {
		const rel = relative(base, candidate);
		return !rel.startsWith("..") && !isAbsolute(rel);
	})));
}

function resultText(result: unknown): string {
	const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
	return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
}

type Watchdog = ReturnType<typeof watchdog>;

/** setTimeout fires at once for delays above 2^31 - 1 ms (about 24.8 days); longer limits mean "that long". */
const timerMs = (ms: number) => Math.min(ms, 2 ** 31 - 1);

/** Stall window, wall-clock timeout, and abort, as one failure promise that every awaited step races against. */
function watchdog(request: AgentRunRequest) {
	let reject!: (error: AgentError) => void;
	const failure = new Promise<never>((_, fail) => { reject = fail; });
	failure.catch(() => {});
	let failed: AgentError | undefined;
	const fail = (error: AgentError) => { if (!failed) { failed = error; reject(error); } };
	const startStall = () => setTimeout(() => fail(new AgentError("stall", `no agent events for ${request.stallMs} ms`)), timerMs(request.stallMs));
	let stall = startStall();
	const timeout = setTimeout(() => fail(new AgentError("timeout", `attempt exceeded ${request.timeoutMs} ms`)), timerMs(request.timeoutMs));
	const onAbort = () => fail(new AgentError("fatal", "aborted"));
	request.signal.addEventListener("abort", onAbort, { once: true });
	return {
		get failed() { return failed; },
		fail,
		touch() { if (!failed) { clearTimeout(stall); stall = startStall(); } },
		/** `orphan` disposes a value that resolves after the run already failed. */
		race<T>(work: Promise<T>, orphan?: (value: T) => void): Promise<T> {
			work.then((value) => { if (failed) orphan?.(value); }, () => {});
			return Promise.race([work, failure]);
		},
		clear() {
			clearTimeout(stall);
			clearTimeout(timeout);
			request.signal.removeEventListener("abort", onAbort);
		},
	};
}

async function settle(work: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([work.catch(() => {}), new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
	clearTimeout(timer);
}
